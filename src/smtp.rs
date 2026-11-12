//! SMTP client with outcome classification that mirrors the Node reference
//! (`classifySmtpError`): only failures proven to occur before any message data was
//! transmitted are `safe_retry`; anything ambiguous after that is `unknown` and never
//! retried automatically.
//!
//! Two delivery modes (`SMTP_DELIVERY_MODE`):
//! - `relay`: submission to a single relay (SMTP_HOST/SMTP_PORT/SMTP_TLS_MODE, optional AUTH).
//! - `direct`: delivery to the recipient domain's MX hosts (see [`plan_mx`]), port 25,
//!   opportunistic STARTTLS (Postfix `smtp_tls_security_level=may`), no AUTH.
//!   Unreachable hosts and 4xx replies before MAIL FROM is accepted move on to the next
//!   MX; 5xx to MAIL/RCPT/DATA is `failed`; 4xx to MAIL (after the last MX)/RCPT/DATA is
//!   `safe_retry`; a missing final reply after the message body was sent is `unknown`.
//!
//! Every message is DKIM-signed right before transmission when a key is configured.

use crate::config::{DeliveryMode, SmtpTlsMode};
use crate::dkim::Dkim;
use base64::Engine;
use rand::seq::SliceRandom;
use serde_json::json;
use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use tokio_rustls::rustls::client::WebPkiServerVerifier;
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use tokio_rustls::TlsConnector;

/// Postfix `smtp_mx_address_limit` equivalent.
const MAX_DIRECT_ADDRESSES: usize = 5;

#[derive(Clone)]
pub struct SmtpConfig {
    pub mode: DeliveryMode,
    pub host: String,
    pub port: u16,
    pub tls_mode: SmtpTlsMode,
    pub username: Option<String>,
    pub password: Option<String>,
    pub timeout: Duration,
    pub helo_name: String,
    pub direct_port: u16,
    pub ipv4_only: bool,
    pub dkim: Option<Arc<Dkim>>,
    /// MX/address resolver for direct mode; `None` uses the system resolver.
    pub resolver: Option<Arc<dyn MxResolver>>,
}

impl std::fmt::Debug for SmtpConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmtpConfig")
            .field("mode", &self.mode)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("tls_mode", &self.tls_mode)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("timeout", &self.timeout)
            .field("helo_name", &self.helo_name)
            .field("direct_port", &self.direct_port)
            .field("ipv4_only", &self.ipv4_only)
            .field("dkim", &self.dkim)
            .field("custom_resolver", &self.resolver.is_some())
            .finish()
    }
}

impl Default for SmtpConfig {
    fn default() -> Self {
        Self {
            mode: DeliveryMode::Relay,
            host: "127.0.0.1".into(),
            port: 1025,
            tls_mode: SmtpTlsMode::PlainLocal,
            username: None,
            password: None,
            timeout: Duration::from_secs(30),
            helo_name: "raxo-email.local".into(),
            direct_port: 25,
            ipv4_only: true,
            dkim: None,
            resolver: None,
        }
    }
}

impl SmtpConfig {
    pub fn from_app(c: &crate::config::AppConfig) -> Self {
        Self {
            mode: c.smtp_delivery_mode,
            host: c.smtp_host.clone(),
            port: c.smtp_port,
            tls_mode: c.smtp_tls_mode,
            username: c.smtp_username.clone(),
            password: c.smtp_password.clone(),
            timeout: Duration::from_secs(30),
            helo_name: c.smtp_helo_name.clone().unwrap_or_else(|| "raxo-email.local".into()),
            direct_port: c.smtp_direct_port,
            ipv4_only: c.smtp_direct_ipv4_only,
            dkim: c.dkim.clone(),
            resolver: None,
        }
    }
}

/// Facts about a successful delivery, recorded in the receipt.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DeliveryInfo {
    /// MX host actually used (direct mode).
    pub mx_host: Option<String>,
    pub ip: Option<String>,
    /// "verified" | "unverified" | "none" (direct mode).
    pub tls: Option<&'static str>,
    /// (d=, s=) when the message was DKIM-signed.
    pub dkim: Option<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SubmitResult {
    Submitted { response: String, accepted: Vec<String>, info: DeliveryInfo },
    SafeRetry(String),
    Failed(String),
    Unknown(String),
}

impl SubmitResult {
    pub fn receipt(&self) -> Option<serde_json::Value> {
        match self {
            SubmitResult::Submitted { response, accepted, info } => {
                let mut r = json!({"response": response, "accepted": accepted});
                let o = r.as_object_mut().unwrap();
                if let Some(h) = &info.mx_host {
                    o.insert("delivery".into(), json!("direct"));
                    o.insert("mx_host".into(), json!(h));
                }
                if let Some(ip) = &info.ip {
                    o.insert("ip".into(), json!(ip));
                }
                if let Some(t) = info.tls {
                    o.insert("tls".into(), json!(t));
                }
                if let Some((d, s)) = &info.dkim {
                    o.insert("dkim".into(), json!({"d": d, "s": s}));
                }
                Some(r)
            }
            _ => None,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            SubmitResult::Submitted { .. } => "submitted",
            SubmitResult::SafeRetry(_) => "safe_retry",
            SubmitResult::Failed(_) => "failed",
            SubmitResult::Unknown(_) => "unknown",
        }
    }
}

// ---------------- DNS ----------------

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq)]
pub enum DnsAnswer<T> {
    Records(Vec<T>),
    /// Name exists but has no records of this type (NODATA).
    NoRecords,
    NxDomain,
    /// SERVFAIL, timeout, network error.
    TempFail(String),
}

pub trait MxResolver: Send + Sync {
    /// MX records as (preference, exchange); the Null MX exchange is reported as ".".
    fn mx<'a>(&'a self, domain: &'a str) -> BoxFut<'a, DnsAnswer<(u16, String)>>;
    fn ips<'a>(&'a self, host: &'a str, ipv4_only: bool) -> BoxFut<'a, DnsAnswer<IpAddr>>;
}

pub struct SystemResolver(hickory_resolver::TokioResolver);

impl SystemResolver {
    pub fn new() -> Result<Self, String> {
        let r = hickory_resolver::TokioResolver::builder_tokio()
            .map_err(|e| format!("cannot read system DNS configuration: {e}"))?
            .build()
            .map_err(|e| format!("cannot build DNS resolver: {e}"))?;
        Ok(Self(r))
    }

    pub fn shared() -> Result<Arc<dyn MxResolver>, String> {
        static R: OnceLock<Arc<SystemResolver>> = OnceLock::new();
        if let Some(r) = R.get() {
            return Ok(r.clone());
        }
        let r = Arc::new(Self::new()?);
        Ok(R.get_or_init(|| r).clone())
    }

    pub fn inner(&self) -> &hickory_resolver::TokioResolver {
        &self.0
    }
}

fn fqdn(name: &str) -> String {
    if name.ends_with('.') {
        name.to_string()
    } else {
        format!("{name}.")
    }
}

fn map_dns_err<T>(e: &hickory_resolver::net::NetError) -> DnsAnswer<T> {
    if e.is_nx_domain() {
        DnsAnswer::NxDomain
    } else if e.is_no_records_found() {
        DnsAnswer::NoRecords
    } else {
        DnsAnswer::TempFail(e.to_string())
    }
}

impl MxResolver for SystemResolver {
    fn mx<'a>(&'a self, domain: &'a str) -> BoxFut<'a, DnsAnswer<(u16, String)>> {
        Box::pin(async move {
            use hickory_resolver::proto::rr::RData;
            match self.0.mx_lookup(fqdn(domain)).await {
                Ok(l) => {
                    let v: Vec<(u16, String)> = l
                        .answers()
                        .iter()
                        .filter_map(|r| match &r.data {
                            RData::MX(mx) => Some((
                                mx.preference,
                                if mx.exchange.is_root() {
                                    ".".to_string()
                                } else {
                                    mx.exchange.to_ascii().trim_end_matches('.').to_ascii_lowercase()
                                },
                            )),
                            _ => None,
                        })
                        .collect();
                    if v.is_empty() {
                        DnsAnswer::NoRecords
                    } else {
                        DnsAnswer::Records(v)
                    }
                }
                Err(e) => map_dns_err(&e),
            }
        })
    }

    fn ips<'a>(&'a self, host: &'a str, ipv4_only: bool) -> BoxFut<'a, DnsAnswer<IpAddr>> {
        Box::pin(async move {
            use hickory_resolver::proto::rr::RData;
            let name = fqdn(host);
            let collect = |l: hickory_resolver::lookup::Lookup| -> Vec<IpAddr> {
                l.answers()
                    .iter()
                    .filter_map(|r| match &r.data {
                        RData::A(a) => Some(IpAddr::V4(a.0)),
                        RData::AAAA(a) => Some(IpAddr::V6(a.0)),
                        _ => None,
                    })
                    .collect()
            };
            let v4 = match self.0.ipv4_lookup(name.clone()).await {
                Ok(l) => DnsAnswer::Records(collect(l)),
                Err(e) => map_dns_err(&e),
            };
            if ipv4_only {
                return match v4 {
                    DnsAnswer::Records(v) if v.is_empty() => DnsAnswer::NoRecords,
                    other => other,
                };
            }
            let v6 = match self.0.ipv6_lookup(name).await {
                Ok(l) => DnsAnswer::Records(collect(l)),
                Err(e) => map_dns_err(&e),
            };
            merge_ip_answers(v4, v6)
        })
    }
}

/// Combines A and AAAA answers, IPv4 addresses first.
pub fn merge_ip_answers(v4: DnsAnswer<IpAddr>, v6: DnsAnswer<IpAddr>) -> DnsAnswer<IpAddr> {
    let mut ips = vec![];
    let mut temp = None;
    let mut nx = false;
    for a in [v4, v6] {
        match a {
            DnsAnswer::Records(v) => ips.extend(v),
            DnsAnswer::TempFail(e) => temp = Some(e),
            DnsAnswer::NxDomain => nx = true,
            DnsAnswer::NoRecords => {}
        }
    }
    if !ips.is_empty() {
        DnsAnswer::Records(ips)
    } else if let Some(e) = temp {
        DnsAnswer::TempFail(e)
    } else if nx {
        DnsAnswer::NxDomain
    } else {
        DnsAnswer::NoRecords
    }
}

/// Outcome of MX resolution for a recipient domain.
#[derive(Debug, Clone, PartialEq)]
pub enum MxPlan {
    /// Hosts in the order to try. `implicit` means no MX existed and the domain itself
    /// is used (RFC 5321 section 5.1).
    Hosts {
        hosts: Vec<String>,
        implicit: bool,
    },
    Permanent(String),
    Temporary(String),
}

/// Pure MX selection: lowest preference first, equal preferences in random order,
/// Null MX (RFC 7505) and NXDOMAIN are permanent, resolver failures temporary.
pub fn plan_mx<R: rand::Rng + ?Sized>(domain: &str, answer: DnsAnswer<(u16, String)>, rng: &mut R) -> MxPlan {
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    match answer {
        DnsAnswer::TempFail(_) => MxPlan::Temporary("dns_tempfail".into()),
        DnsAnswer::NxDomain => MxPlan::Permanent("dns_nxdomain".into()),
        DnsAnswer::NoRecords => MxPlan::Hosts { hosts: vec![domain], implicit: true },
        DnsAnswer::Records(v) if v.is_empty() => MxPlan::Hosts { hosts: vec![domain], implicit: true },
        DnsAnswer::Records(v) => {
            let norm = |h: &str| h.trim().trim_end_matches('.').to_ascii_lowercase();
            let mut real: Vec<(u16, String)> =
                v.iter().map(|(p, h)| (*p, norm(h))).filter(|(_, h)| !h.is_empty()).collect();
            if real.is_empty() {
                return MxPlan::Permanent("null_mx".into());
            }
            real.shuffle(rng);
            real.sort_by_key(|(p, _)| *p);
            let mut hosts: Vec<String> = Vec::with_capacity(real.len());
            for (_, h) in real {
                if !hosts.contains(&h) {
                    hosts.push(h);
                }
            }
            MxPlan::Hosts { hosts, implicit: false }
        }
    }
}

// ---------------- TLS ----------------

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

fn webpki_verifier() -> Arc<WebPkiServerVerifier> {
    static V: OnceLock<Arc<WebPkiServerVerifier>> = OnceLock::new();
    V.get_or_init(|| {
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
        WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider).build().expect("webpki verifier")
    })
    .clone()
}

/// Opportunistic TLS: performs full WebPKI verification against the MX hostname but only
/// records the result instead of aborting, like Postfix `smtp_tls_security_level=may`.
/// Handshake signatures are still checked.
#[derive(Debug)]
struct RecordingVerifier {
    inner: Arc<WebPkiServerVerifier>,
    verified: Arc<AtomicBool>,
}

impl ServerCertVerifier for RecordingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, tokio_rustls::rustls::Error> {
        if self.inner.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now).is_ok() {
            self.verified.store(true, Ordering::SeqCst);
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// STARTTLS for direct delivery. Returns the stream and whether the certificate verified.
async fn upgrade_opportunistic(sock: Box<dyn Io>, host: &str, t: Duration) -> Result<(Box<dyn Io>, bool), String> {
    let verified = Arc::new(AtomicBool::new(false));
    let verifier = Arc::new(RecordingVerifier { inner: webpki_verifier(), verified: verified.clone() });
    let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
    let cfg = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    let name = ServerName::try_from(host.to_string()).map_err(|_| "invalid_server_name".to_string())?;
    match timeout(t, TlsConnector::from(Arc::new(cfg)).connect(name, sock)).await {
        Err(_) => Err("tls_handshake_timeout".into()),
        Ok(Err(e)) => Err(format!("tls_handshake_failed: {e}")),
        Ok(Ok(s)) => Ok((Box::new(s), verified.load(Ordering::SeqCst))),
    }
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

async fn relay_session(raw: &[u8], from: &str, to: &str, cfg: &SmtpConfig) -> Result<(String, Vec<String>), Fail> {
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
    let ehlo_name = cfg.helo_name.as_str();
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

fn advertises(ehlo: &Reply, ext: &str) -> bool {
    ehlo.text
        .lines()
        .skip(1)
        .any(|l| l.get(4..).and_then(|kw| kw.split_whitespace().next()).is_some_and(|kw| kw.eq_ignore_ascii_case(ext)))
}

/// Failure of one direct attempt: either try the next address/MX or stop here.
enum HostErr {
    Next(Fail),
    Final(Fail),
    TlsHandshake(String),
}

struct DirectOk {
    response: String,
    tls: &'static str,
}

async fn direct_session(
    raw: &[u8],
    from: &str,
    to: &str,
    host: &str,
    ip: IpAddr,
    cfg: &SmtpConfig,
    try_starttls: bool,
) -> Result<DirectOk, HostErr> {
    use HostErr::{Final, Next};
    let t = cfg.timeout;
    let safe = |e: io::Error| Next(Fail::SafeRetry(net_code(&e)));
    let tcp = match timeout(t, TcpStream::connect(SocketAddr::new(ip, cfg.direct_port))).await {
        Err(_) => return Err(Next(Fail::SafeRetry("etimedout".into()))),
        Ok(Err(e)) => return Err(Next(pre_connect_failure(&e))),
        Ok(Ok(s)) => s,
    };
    let _ = tcp.set_nodelay(true);
    let mut c = Conn { r: BufReader::new(Box::new(tcp) as Box<dyn Io>), t };

    let g = c.read_reply().await.map_err(safe)?;
    if g.code != 220 {
        return Err(Next(Fail::SafeRetry(format!("smtp_{}_greeting", g.code))));
    }
    let helo = cfg.helo_name.as_str();
    let mut ehlo = c.cmd(&format!("EHLO {helo}")).await.map_err(safe)?;
    if ehlo.code >= 500 {
        ehlo = c.cmd(&format!("HELO {helo}")).await.map_err(safe)?;
    }
    if ehlo.code >= 400 {
        return Err(Next(Fail::SafeRetry(format!("smtp_{}", ehlo.code))));
    }

    let mut tls = "none";
    if try_starttls && advertises(&ehlo, "STARTTLS") {
        let r = c.cmd("STARTTLS").await.map_err(safe)?;
        if r.code == 220 {
            let inner = c.r.into_inner();
            let (up, verified) = upgrade_opportunistic(inner, host, t).await.map_err(HostErr::TlsHandshake)?;
            tls = if verified { "verified" } else { "unverified" };
            c = Conn { r: BufReader::new(up), t };
            let e = c.cmd(&format!("EHLO {helo}")).await.map_err(safe)?;
            if e.code >= 400 {
                return Err(Next(Fail::SafeRetry(format!("smtp_{}", e.code))));
            }
        }
        // STARTTLS refused: continue in plaintext on the same session.
    }

    let r = c.cmd(&format!("MAIL FROM:<{from}>")).await.map_err(safe)?;
    if r.code >= 500 {
        return Err(Final(Fail::Failed(format!("smtp_{}", r.code))));
    }
    if r.code >= 300 {
        return Err(Next(Fail::SafeRetry(format!("smtp_{}", r.code))));
    }
    // From here on the session belongs to this MX: no fallback to other hosts.
    let fin = |e: io::Error| Final(Fail::SafeRetry(net_code(&e)));
    let r = c.cmd(&format!("RCPT TO:<{to}>")).await.map_err(fin)?;
    if r.code >= 300 {
        return Err(Final(if r.code >= 500 { reply_fail(&r) } else { Fail::SafeRetry(format!("smtp_{}", r.code)) }));
    }
    let r = c.cmd("DATA").await.map_err(fin)?;
    if r.code != 354 {
        return Err(Final(if r.code >= 500 { reply_fail(&r) } else { Fail::SafeRetry(format!("smtp_{}", r.code)) }));
    }
    c.send(&dot_stuff(raw)).await.map_err(|e| Final(mid_io_fail(&e)))?;
    let r = c.read_reply().await.map_err(|e| Final(mid_io_fail(&e)))?;
    if r.code >= 400 {
        return Err(Final(reply_fail(&r)));
    }
    if r.code >= 300 {
        return Err(Final(Fail::Unknown(format!("smtp_{}", r.code))));
    }
    let response: String = r.text.chars().take(500).collect();
    let _ = c.cmd("QUIT").await;
    Ok(DirectOk { response, tls })
}

async fn direct_delivery(raw: &[u8], from: &str, to: &str, cfg: &SmtpConfig) -> Result<(String, DeliveryInfo), Fail> {
    let Some((_, domain)) = to.rsplit_once('@').filter(|(l, d)| !l.is_empty() && !d.is_empty()) else {
        return Err(Fail::Failed("invalid_recipient".into()));
    };
    let domain = domain.to_ascii_lowercase();
    let resolver = match &cfg.resolver {
        Some(r) => r.clone(),
        None => SystemResolver::shared().map_err(|e| {
            tracing::error!(error = %e, "DNS resolver unavailable");
            Fail::SafeRetry("dns_unavailable".into())
        })?,
    };
    let answer = timeout(cfg.timeout, resolver.mx(&domain)).await.unwrap_or(DnsAnswer::TempFail("timeout".into()));
    let plan = plan_mx(&domain, answer, &mut rand::thread_rng());
    let (hosts, implicit) = match plan {
        MxPlan::Hosts { hosts, implicit } => (hosts, implicit),
        MxPlan::Permanent(c) => return Err(Fail::Failed(c)),
        MxPlan::Temporary(c) => return Err(Fail::SafeRetry(c)),
    };

    let mut last = Fail::SafeRetry("no_mx_reachable".into());
    let mut tried = 0;
    for host in &hosts {
        if tried >= MAX_DIRECT_ADDRESSES {
            break;
        }
        let ips = timeout(cfg.timeout, resolver.ips(host, cfg.ipv4_only))
            .await
            .unwrap_or(DnsAnswer::TempFail("timeout".into()));
        let ips: Vec<IpAddr> = match ips {
            DnsAnswer::Records(v) => v.into_iter().filter(|ip| !cfg.ipv4_only || ip.is_ipv4()).collect(),
            DnsAnswer::TempFail(_) => {
                last = Fail::SafeRetry("dns_tempfail".into());
                continue;
            }
            DnsAnswer::NxDomain | DnsAnswer::NoRecords => vec![],
        };
        if ips.is_empty() {
            if implicit {
                return Err(Fail::Failed("no_mx_or_address".into()));
            }
            tracing::warn!(mx = %host, "MX host has no usable address");
            last = Fail::SafeRetry("mx_host_unresolvable".into());
            continue;
        }
        for ip in ips {
            if tried >= MAX_DIRECT_ADDRESSES {
                break;
            }
            tried += 1;
            let mut r = direct_session(raw, from, to, host, ip, cfg, true).await;
            if let Err(HostErr::TlsHandshake(e)) = &r {
                tracing::warn!(mx = %host, %ip, error = %e, "STARTTLS handshake failed; retrying in plaintext");
                r = direct_session(raw, from, to, host, ip, cfg, false).await;
            }
            match r {
                Ok(ok) => {
                    let info = DeliveryInfo {
                        mx_host: Some(host.clone()),
                        ip: Some(ip.to_string()),
                        tls: Some(ok.tls),
                        dkim: None,
                    };
                    return Ok((ok.response, info));
                }
                Err(HostErr::Final(f)) => return Err(f),
                Err(HostErr::Next(f)) => {
                    let code = match &f {
                        Fail::SafeRetry(c) | Fail::Failed(c) | Fail::Unknown(c) => c.clone(),
                    };
                    tracing::warn!(mx = %host, %ip, code, "MX attempt failed; trying next");
                    last = f;
                }
                Err(HostErr::TlsHandshake(_)) => last = Fail::SafeRetry("tls_handshake_failed".into()),
            }
        }
    }
    Err(last)
}

pub async fn submit_raw(raw: &[u8], from: &str, to: &str, cfg: &SmtpConfig) -> SubmitResult {
    let mut dkim_used = None;
    let signed;
    let message: &[u8] = match &cfg.dkim {
        None => raw,
        Some(d) => {
            match crate::dkim::header_from_domain(raw) {
                Some(fd) if d.aligned_with(&fd) => {}
                fd => tracing::warn!(
                    from_domain = fd.as_deref().unwrap_or("<none>"),
                    dkim_domain = d.domain(),
                    "From domain is not aligned with DKIM_DOMAIN; signing anyway (DMARC will not pass via DKIM)"
                ),
            }
            match d.sign(raw) {
                Ok(s) => {
                    signed = s;
                    dkim_used = Some((d.domain().to_string(), d.selector().to_string()));
                    &signed
                }
                Err(e) => {
                    tracing::error!(error = %e, "DKIM signing failed; message not sent");
                    return SubmitResult::Failed("dkim_sign_failed".into());
                }
            }
        }
    };
    let r = match cfg.mode {
        DeliveryMode::Relay => {
            relay_session(message, from, to, cfg).await.map(|(resp, acc)| (resp, acc, DeliveryInfo::default()))
        }
        DeliveryMode::Direct => {
            direct_delivery(message, from, to, cfg).await.map(|(resp, info)| (resp, vec![to.to_string()], info))
        }
    };
    match r {
        Ok((response, accepted, mut info)) => {
            info.dkim = dkim_used;
            SubmitResult::Submitted { response, accepted, info }
        }
        Err(Fail::SafeRetry(c)) => SubmitResult::SafeRetry(c),
        Err(Fail::Failed(c)) => SubmitResult::Failed(c),
        Err(Fail::Unknown(c)) => SubmitResult::Unknown(c),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    fn rng(seed: u64) -> rand::rngs::StdRng {
        rand::rngs::StdRng::seed_from_u64(seed)
    }

    fn mx(v: &[(u16, &str)]) -> DnsAnswer<(u16, String)> {
        DnsAnswer::Records(v.iter().map(|(p, h)| (*p, h.to_string())).collect())
    }

    fn hosts(p: MxPlan) -> Vec<String> {
        match p {
            MxPlan::Hosts { hosts, implicit: false } => hosts,
            other => panic!("unexpected plan {other:?}"),
        }
    }

    #[test]
    fn mx_sorted_by_preference_and_deduplicated() {
        let a = mx(&[(30, "c.example."), (10, "A.example."), (20, "b.example"), (10, "a.example")]);
        assert_eq!(hosts(plan_mx("example.com", a, &mut rng(1))), ["a.example", "b.example", "c.example"]);
    }

    #[test]
    fn equal_preferences_are_randomized_but_stay_in_their_tier() {
        let a = mx(&[(20, "z"), (10, "a"), (10, "b"), (10, "c"), (10, "d")]);
        let mut firsts = std::collections::HashSet::new();
        for seed in 0..64 {
            let h = hosts(plan_mx("example.com", a.clone(), &mut rng(seed)));
            assert_eq!(h.len(), 5);
            assert_eq!(h[4], "z");
            firsts.insert(h[0].clone());
        }
        assert!(firsts.len() > 1, "equal-preference hosts should be shuffled");
    }

    #[test]
    fn null_mx_is_permanent() {
        assert_eq!(plan_mx("example.com", mx(&[(0, ".")]), &mut rng(0)), MxPlan::Permanent("null_mx".into()));
        // A stray null record next to real MX hosts is ignored.
        assert_eq!(
            hosts(plan_mx("example.com", mx(&[(0, "."), (10, "mx.example.com")]), &mut rng(0))),
            ["mx.example.com"]
        );
    }

    #[test]
    fn no_mx_falls_back_to_the_domain_itself() {
        let want = MxPlan::Hosts { hosts: vec!["example.com".into()], implicit: true };
        assert_eq!(plan_mx("Example.COM.", DnsAnswer::NoRecords, &mut rng(0)), want);
        assert_eq!(plan_mx("example.com", DnsAnswer::Records(vec![]), &mut rng(0)), want);
    }

    #[test]
    fn nxdomain_is_permanent_and_resolver_failure_temporary() {
        assert_eq!(plan_mx("nope.test", DnsAnswer::NxDomain, &mut rng(0)), MxPlan::Permanent("dns_nxdomain".into()));
        assert_eq!(
            plan_mx("x.test", DnsAnswer::TempFail("SERVFAIL".into()), &mut rng(0)),
            MxPlan::Temporary("dns_tempfail".into())
        );
    }

    #[test]
    fn ip_answers_merge_ipv4_first() {
        let v4 = DnsAnswer::Records(vec!["192.0.2.1".parse().unwrap()]);
        let v6 = DnsAnswer::Records(vec!["2001:db8::1".parse().unwrap()]);
        assert_eq!(
            merge_ip_answers(v4, v6),
            DnsAnswer::Records(vec!["192.0.2.1".parse().unwrap(), "2001:db8::1".parse().unwrap()])
        );
        assert_eq!(merge_ip_answers(DnsAnswer::NoRecords, DnsAnswer::NxDomain), DnsAnswer::NxDomain);
        assert!(matches!(
            merge_ip_answers(DnsAnswer::TempFail("x".into()), DnsAnswer::NoRecords),
            DnsAnswer::TempFail(_)
        ));
    }
}
