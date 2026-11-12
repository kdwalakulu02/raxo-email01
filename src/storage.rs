use crate::errors::{AppError, Result};
use sha2::{Digest, Sha256};
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Area {
    Quarantine,
    Clean,
    Mime,
    Tmp,
}

impl Area {
    fn dir(self) -> &'static str {
        match self {
            Area::Quarantine => "quarantine",
            Area::Clean => "clean",
            Area::Mime => "mime",
            Area::Tmp => "tmp",
        }
    }
}

#[derive(Debug, Clone)]
pub struct StagedFile {
    pub key: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Storage {
    root: PathBuf,
}

fn mkdir_private(p: &Path) -> std::io::Result<()> {
    DirBuilder::new().recursive(true).mode(0o700).create(p)
}

fn sync_dir(p: &Path) {
    if let Ok(d) = fs::File::open(p) {
        let _ = d.sync_all();
    }
}

fn valid_key(k: &str) -> bool {
    Uuid::parse_str(k).is_ok() && k.len() == 36
}

/// Streaming writer used while receiving an upload; computes SHA-256 and
/// enforces the size cap before the file is moved into quarantine.
pub struct StageWriter {
    key: String,
    tmp: PathBuf,
    quarantine: PathBuf,
    quarantine_dir: PathBuf,
    file: Option<tokio::fs::File>,
    hash: Sha256,
    bytes: u64,
    max: u64,
}

impl StageWriter {
    pub async fn write(&mut self, chunk: &[u8]) -> Result<()> {
        self.bytes += chunk.len() as u64;
        if self.bytes > self.max {
            return Err(AppError::new(
                "file_too_large",
                413,
                format!("Attachment exceeds maximum size of {} bytes", self.max),
            ));
        }
        self.hash.update(chunk);
        self.file.as_mut().expect("open").write_all(chunk).await?;
        Ok(())
    }

    pub async fn finish(mut self) -> Result<StagedFile> {
        let mut f = self.file.take().expect("open");
        f.flush().await?;
        f.sync_all().await?;
        drop(f);
        fs::rename(&self.tmp, &self.quarantine)?;
        sync_dir(&self.quarantine_dir);
        Ok(StagedFile {
            key: self.key.clone(),
            size_bytes: self.bytes,
            sha256: hex::encode(std::mem::take(&mut self.hash).finalize()),
            path: self.quarantine.clone(),
        })
    }

    pub async fn abort(mut self) {
        self.file.take();
        let _ = fs::remove_file(&self.tmp);
    }
}

impl Storage {
    pub fn new(dir: &Path) -> Result<Self> {
        let root = dir.to_path_buf();
        for a in ["quarantine", "clean", "mime", "tmp"] {
            mkdir_private(&root.join(a))?;
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn resolve(&self, key: &str, area: Area) -> Result<PathBuf> {
        if !valid_key(key) {
            return Err(AppError::bad_request("Invalid storage key format"));
        }
        Ok(self.root.join(area.dir()).join(key.to_ascii_lowercase()))
    }

    pub async fn begin_stage(&self, max_bytes: u64) -> Result<StageWriter> {
        let key = Uuid::new_v4().to_string();
        let tmp = self.resolve(&key, Area::Tmp)?;
        let quarantine = self.resolve(&key, Area::Quarantine)?;
        let std_file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        Ok(StageWriter {
            key,
            tmp,
            quarantine,
            quarantine_dir: self.root.join("quarantine"),
            file: Some(tokio::fs::File::from_std(std_file)),
            hash: Sha256::new(),
            bytes: 0,
            max: max_bytes,
        })
    }

    fn areas(area: Option<Area>) -> Vec<Area> {
        area.map(|a| vec![a]).unwrap_or_else(|| vec![Area::Clean, Area::Quarantine])
    }

    pub fn locate(&self, key: &str, area: Option<Area>) -> Result<PathBuf> {
        for a in Self::areas(area) {
            let p = self.resolve(key, a)?;
            if p.exists() {
                return Ok(p);
            }
        }
        Err(AppError::not_found(format!("File not found for key: {key}")))
    }

    pub fn read(&self, key: &str, area: Option<Area>) -> Result<Vec<u8>> {
        Ok(fs::read(self.locate(key, area)?)?)
    }

    pub fn move_to_clean(&self, key: &str) -> Result<()> {
        let q = self.resolve(key, Area::Quarantine)?;
        let c = self.resolve(key, Area::Clean)?;
        if !q.exists() {
            if c.exists() {
                return Ok(());
            }
            return Err(AppError::not_found(format!("Quarantine file not found for key: {key}")));
        }
        fs::rename(q, c)?;
        Ok(())
    }

    pub fn move_to_quarantine(&self, key: &str) -> Result<()> {
        let q = self.resolve(key, Area::Quarantine)?;
        let c = self.resolve(key, Area::Clean)?;
        if q.exists() {
            if c.exists() {
                return Err(AppError::new(
                    "storage_conflict",
                    500,
                    format!("Attachment exists in both storage areas for key: {key}"),
                ));
            }
            return Ok(());
        }
        if !c.exists() {
            return Err(AppError::not_found(format!("Attachment file not found for key: {key}")));
        }
        fs::rename(c, q)?;
        Ok(())
    }

    pub fn delete(&self, key: &str, area: Option<Area>) -> Result<()> {
        let areas = match area {
            Some(a) => vec![a],
            None => vec![Area::Clean, Area::Quarantine, Area::Mime, Area::Tmp],
        };
        for a in areas {
            match fs::remove_file(self.resolve(key, a)?) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }

    pub fn exists(&self, key: &str, area: Option<Area>) -> bool {
        let areas = area.map(|a| vec![a]).unwrap_or_else(|| vec![Area::Clean, Area::Quarantine, Area::Mime]);
        areas.into_iter().any(|a| self.resolve(key, a).map(|p| p.exists()).unwrap_or(false))
    }

    pub fn persist_mime(&self, data: &[u8]) -> Result<(String, String)> {
        let key = Uuid::new_v4().to_string();
        let path = self.resolve(&key, Area::Mime)?;
        let mut f = OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
        f.write_all(data)?;
        f.sync_all()?;
        Ok((key, sha256_hex(data)))
    }

    pub fn sweep_tmp(&self, max_age: Duration) -> Vec<String> {
        self.sweep_dir(Area::Tmp, max_age, |_| true)
    }

    /// Removes quarantine files older than `max_age` whose key is not in `referenced`.
    pub fn sweep_unreferenced_quarantine(
        &self,
        max_age: Duration,
        referenced: &std::collections::HashSet<String>,
    ) -> Vec<String> {
        self.sweep_dir(Area::Quarantine, max_age, |k| !referenced.contains(k))
    }

    pub fn sweep_unreferenced_mime(
        &self,
        max_age: Duration,
        referenced: &std::collections::HashSet<String>,
    ) -> Vec<String> {
        self.sweep_dir(Area::Mime, max_age, |k| !referenced.contains(k))
    }

    fn sweep_dir(&self, area: Area, max_age: Duration, eligible: impl Fn(&str) -> bool) -> Vec<String> {
        let mut swept = vec![];
        let dir = self.root.join(area.dir());
        let Ok(rd) = fs::read_dir(&dir) else { return swept };
        let now = SystemTime::now();
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !valid_key(&name) || !eligible(&name) {
                continue;
            }
            if let Ok(md) = e.metadata() {
                let age = md.modified().ok().and_then(|m| now.duration_since(m).ok()).unwrap_or_default();
                if age > max_age && fs::remove_file(e.path()).is_ok() {
                    swept.push(name);
                }
            }
        }
        swept
    }

    pub fn list_keys(&self, area: Area) -> Vec<String> {
        fs::read_dir(self.root.join(area.dir()))
            .map(|rd| {
                rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| valid_key(n)).collect()
            })
            .unwrap_or_default()
    }

    pub fn is_writable(&self) -> bool {
        let p = self.root.join("tmp").join(format!(".health-{}", Uuid::new_v4()));
        match fs::write(&p, b"ok") {
            Ok(()) => {
                let _ = fs::remove_file(&p);
                true
            }
            Err(_) => false,
        }
    }

    pub fn snapshot_dir(&self) -> Result<PathBuf> {
        let p = self.root.join("scan-snapshots");
        mkdir_private(&p)?;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o700));
        Ok(p)
    }
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}
