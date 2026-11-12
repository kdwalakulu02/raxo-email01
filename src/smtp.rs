//! Minimal SMTP submission client with outcome classification that mirrors the
//! Node reference (`classifySmtpError`): only failures proven to occur before any
//! message data was transmitted are `safe_retry`; anything ambiguous after that is
//! `unknown` and never retried automatically.

use crate::config::SmtpTlsMode;
use base64::Engine;
use serde_json::json;
use std::io;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

#[derive(Debug, Clone)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub tls_mode: SmtpTlsMode,
    pub username: Option<String>,
    pub password: Option<String>,
    pub timeout: Duration,
}

impl SmtpConfig {
    pub fn from_app(c: &crate::config::AppConfig) -> Self {
        Self {
            host: c.smtp_host.clone(),
            port: c.smtp_port,
            tls_mode: c.smtp_tls_mode,
            username: c.smtp_username.clone(),
            password: c.smtp_password.clone(),
            timeout: Duration::from_secs(30),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SubmitResult {
    Submitted { response: String, accepted: Vec<String> },
    SafeRetry(String),
    Failed(String),
    Unknown(String),
}

impl SubmitResult {
    pub fn receipt(&self) -> Option<serde_json::Value> {
        match self {
            SubmitResult::Submitted { response, accepted } => Some(json!({"response": response, "accepted": accepted})),
            _ => None,
        }
    }
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// Internal error with the classification already decided at the failure site.
enum Fail {
    SafeRetry(String),
    Failed(String),
    Unknown(String),
}

fn tls_config() -> Arc<ClientConfig> {
    static CFG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    CFG.get_or_init(|| {
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
        Arc::new(
            ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        )
    })
    .clone()
}

fn net_code(e: &io::Error) -> String {
    match e.raw_os_error() {
        Some(111) => "econnrefused".into(),
        Some(113) => "ehostunreach".into(),
        Some(101) => "enetunreach".into(),
        _ => match e.kind() {
            io::ErrorKind::ConnectionRefused => "econnrefused".into(),
            io::ErrorKind::TimedOut => "etimedout".into(),
            io::ErrorKind::ConnectionReset => "econnreset".into(),
            io::ErrorKind::BrokenPipe => "epipe".into(),
            io::ErrorKind::UnexpectedEof => "econnection".into(),
            _ => "econnection".into(),
        },
    }
}

fn pre_connect_failure(e: &io::Error) -> Fail {
    let c = net_code(e);
    // Failure to resolve DNS surfaces as an Uncategorized/Other error from lookup_host.
    if matches!(c.as_str(), "econnrefused" | "ehostunreach" | "enetunreach") {
        Fail::SafeRetry(c)
    } else if e.kind() == io::ErrorKind::TimedOut {
        Fail::SafeRetry("etimedout".into())
    } else {
        Fail::SafeRetry("enotfound".into())
    }
}

struct Reply {
    code: u16,
    text: String,
}

struct Conn {
    r: BufReader<Box<dyn Io>>,
    t: Duration,
}

impl Conn {
    async fn read_reply(&mut self) -> Result<Reply, io::Error> {
        let mut text = String::new();
        loop {
            let mut line = String::new();
            let n = timeout(self.t, self.r.read_line(&mut line))
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "socket timeout"))??;
            if n == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed"));
            }
            let l = line.trim_end_matches(['\r', '\n']);
            if l.len() < 3 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "malformed reply"));
            }
            let code: u16 =
                l[..3].parse().map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "malformed reply"))?;
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(l);
            if l.len() == 3 || l.as_bytes()[3] == b' ' {
                return Ok(Reply { code, text });
            }
        }
    }

    async fn send(&mut self, data: &[u8]) -> Result<(), io::Error> {
        let w = self.r.get_mut();
        timeout(self.t, async {
            w.write_all(data).await?;
            w.flush().await
        })
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "socket timeout"))?
    }

    async fn cmd(&mut self, c: &str) -> Result<Reply, io::Error> {
        self.send(format!("{c}\r\n").as_bytes()).await?;
        self.read_reply().await
    }
}

fn reply_fail(r: &Reply) -> Fail {
    if r.code >= 500 {
        Fail::Failed(format!("smtp_{}", r.code))
    } else if r.code >= 400 {
        Fail::SafeRetry(format!("smtp_{}", r.code))
    } else {
        Fail::Unknown(format!("smtp_{}", r.code))
    }
}

fn mid_io_fail(e: &io::Error) -> Fail {
    // Past the greeting: acceptance by the remote MTA cannot be ruled in or out.
    Fail::Unknown(net_code(e))
}

fn tls_fail(e: &io::Error) -> Fail {
    let s = e.to_string().to_lowercase();
    if s.contains("expired") {
        Fail::Failed("cert_has_expired".into())
    } else if s.contains("notvalidforname") || s.contains("not valid for name") {
        Fail::Failed("err_tls_cert_altname_invalid".into())
    } else if s.contains("unknownissuer") || s.contains("unknown issuer") || s.contains("self") {
        Fail::Failed("depth_zero_self_signed_cert".into())
    } else {
        Fail::Failed("tls_error".into())
    }
}

async fn upgrade_tls(sock: Box<dyn Io>, host: &str, t: Duration) -> Result<Box<dyn Io>, Fail> {
    let name =
        ServerName::try_from(host.to_string()).map_err(|_| Fail::Failed("err_tls_cert_altname_invalid".into()))?;
    let connector = TlsConnector::from(tls_config());
    match timeout(t, connector.connect(name, sock)).await {
        Err(_) => Err(Fail::SafeRetry("etimedout".into())),
        Ok(Err(e)) => Err(tls_fail(&e)),
        Ok(Ok(s)) => Ok(Box::new(s)),
    }
}

fn dot_stuff(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + 64);
    let mut at_line_start = true;
    for &b in raw {
        if at_line_start && b == b'.' {
            out.push(b'.');
        }
        out.push(b);
        at_line_start = b == b'\n';
    }
    if !out.ends_with(b"\r\n") {
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b".\r\n");
    out
}

async fn session(raw: &[u8], from: &str, to: &str, cfg: &SmtpConfig) -> Result<(String, Vec<String>), Fail> {
    let t = cfg.timeout;
    let implicit = cfg.tls_mode == SmtpTlsMode::Implicit || cfg.port == 465;

    let addrs = timeout(t, tokio::net::lookup_host((cfg.host.as_str(), cfg.port)))
        .await
        .map_err(|_| Fail::SafeRetry("etimedout".into()))?
        .map_err(|_| Fail::SafeRetry("enotfound".into()))?
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err(Fail::SafeRetry("enotfound".into()));
    }
    let mut last: Option<io::Error> = None;
    let mut tcp = None;
    for a in addrs {
        match timeout(t, TcpStream::connect(a)).await {
            Err(_) => last = Some(io::Error::new(io::ErrorKind::TimedOut, "connect timeout")),
            Ok(Err(e)) => last = Some(e),
            Ok(Ok(s)) => {
                tcp = Some(s);
                break;
            }
        }
    }
    let Some(tcp) = tcp else { return Err(pre_connect_failure(&last.unwrap())) };
    let _ = tcp.set_nodelay(true);

    let mut io_box: Box<dyn Io> = Box::new(tcp);
    if implicit {
        io_box = upgrade_tls(io_box, &cfg.host, t).await?;
    }
    let mut c = Conn { r: BufReader::new(io_box), t };

    // greeting
    let g = match c.read_reply().await {
        Ok(r) => r,
        Err(e) if e.kind() == io::ErrorKind::TimedOut => return Err(Fail::SafeRetry("etimedout".into())),
        Err(e) => return Err(Fail::SafeRetry(net_code(&e))),
    };
    if g.code != 220 {
        return Err(reply_fail(&g));
    }
    let ehlo_name = "raxo-email.local";
    let mut ehlo = c.cmd(&format!("EHLO {ehlo_name}")).await.map_err(|e| mid_io_fail(&e))?;
    if ehlo.code >= 400 {
        ehlo = c.cmd(&format!("HELO {ehlo_name}")).await.map_err(|e| mid_io_fail(&e))?;
        if ehlo.code >= 400 {
            return Err(reply_fail(&ehlo));
        }
    }

    if !implicit && cfg.tls_mode != SmtpTlsMode::PlainLocal {
        if !ehlo.text.to_uppercase().contains("STARTTLS") {
            if cfg.tls_mode == SmtpTlsMode::StarttlsRequired {
                return Err(Fail::Failed("etls".into()));
            }
        } else {
            let r = c.cmd("STARTTLS").await.map_err(|e| mid_io_fail(&e))?;
            if r.code != 220 {
                return Err(reply_fail(&r));
            }
            let inner = c.r.into_inner();
            let up = upgrade_tls(inner, &cfg.host, t).await?;
            c = Conn { r: BufReader::new(up), t };
            ehlo = c.cmd(&format!("EHLO {ehlo_name}")).await.map_err(|e| mid_io_fail(&e))?;
            if ehlo.code >= 400 {
                return Err(reply_fail(&ehlo));
            }
        }
    }

    if let (Some(u), Some(p)) = (&cfg.username, &cfg.password) {
        let enc = base64::engine::general_purpose::STANDARD;
        let plain = enc.encode(format!("\0{u}\0{p}"));
        let r = c.cmd(&format!("AUTH PLAIN {plain}")).await.map_err(|e| mid_io_fail(&e))?;
        if r.code != 235 {
            return Err(if r.code >= 500 || r.code == 334 { Fail::Failed("eauth".into()) } else { reply_fail(&r) });
        }
    }

    let r = c.cmd(&format!("MAIL FROM:<{from}>")).await.map_err(|e| mid_io_fail(&e))?;
    if r.code >= 300 {
        return Err(reply_fail(&r));
    }
    let r = c.cmd(&format!("RCPT TO:<{to}>")).await.map_err(|e| mid_io_fail(&e))?;
    if r.code >= 300 {
        return Err(reply_fail(&r));
    }
    let r = c.cmd("DATA").await.map_err(|e| mid_io_fail(&e))?;
    if r.code != 354 {
        return Err(reply_fail(&r));
    }
    c.send(&dot_stuff(raw)).await.map_err(|e| mid_io_fail(&e))?;
    let r = c.read_reply().await.map_err(|e| mid_io_fail(&e))?;
    if r.code >= 400 {
        return Err(reply_fail(&r));
    }
    let resp: String = r.text.chars().take(500).collect();
    let _ = c.cmd("QUIT").await;
    Ok((resp, vec![to.to_string()]))
}

pub async fn submit_raw(raw: &[u8], from: &str, to: &str, cfg: &SmtpConfig) -> SubmitResult {
    match session(raw, from, to, cfg).await {
        Ok((response, accepted)) => SubmitResult::Submitted { response, accepted },
        Err(Fail::SafeRetry(c)) => SubmitResult::SafeRetry(c),
        Err(Fail::Failed(c)) => SubmitResult::Failed(c),
        Err(Fail::Unknown(c)) => SubmitResult::Unknown(c),
    }
}

pub async fn send_system_message(
    to: &str,
    subject: &str,
    text: &str,
    html: &str,
    cfg: &SmtpConfig,
    from: &str,
    message_id_domain: &str,
) -> SubmitResult {
    let mid = format!("<{}@{}>", uuid::Uuid::new_v4(), message_id_domain);
    let raw = crate::mime::build_system_message(from, to, subject, text, html, &mid);
    submit_raw(&raw, from, to, cfg).await
}
