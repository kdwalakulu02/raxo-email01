//! Direct MX delivery against local fake SMTP servers with an injected resolver, plus
//! DKIM sign-then-verify with mail-auth. No PostgreSQL and no network access needed.

use mail_auth::dkim::DomainKey;
use mail_auth::dns::TxtRecordParser;
use mail_auth::{
    AuthenticatedMessage, DkimResult, DnsCache, MessageAuthenticator, NoCache, Parameters, ResolverCache, TxtRecord,
};
use raxo_email::config::DeliveryMode;
use raxo_email::dkim::Dkim;
use raxo_email::smtp::{submit_raw, BoxFut, DnsAnswer, MxResolver, SmtpConfig, SubmitResult};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

// ---------------- fake DNS ----------------

#[derive(Default)]
struct FakeDns {
    mx: HashMap<String, DnsAnswer<(u16, String)>>,
    a: HashMap<String, DnsAnswer<IpAddr>>,
}

impl FakeDns {
    fn mx(mut self, domain: &str, v: &[(u16, &str)]) -> Self {
        self.mx.insert(domain.into(), DnsAnswer::Records(v.iter().map(|(p, h)| (*p, h.to_string())).collect()));
        self
    }
    fn a(mut self, host: &str, ip: &str) -> Self {
        self.a.insert(host.into(), DnsAnswer::Records(vec![ip.parse().unwrap()]));
        self
    }
}

impl MxResolver for FakeDns {
    fn mx<'a>(&'a self, domain: &'a str) -> BoxFut<'a, DnsAnswer<(u16, String)>> {
        Box::pin(async move { self.mx.get(domain).cloned().unwrap_or(DnsAnswer::NxDomain) })
    }
    fn ips<'a>(&'a self, host: &'a str, _ipv4_only: bool) -> BoxFut<'a, DnsAnswer<IpAddr>> {
        Box::pin(async move { self.a.get(host).cloned().unwrap_or(DnsAnswer::NxDomain) })
    }
}

// ---------------- fake MX server ----------------

#[derive(Clone)]
struct Script {
    greeting: &'static str,
    starttls: bool,
    rcpt: &'static str,
    /// `None`: close the connection after the message body without a final reply.
    final_reply: Option<&'static str>,
}

impl Default for Script {
    fn default() -> Self {
        Self {
            greeting: "220 mx.test ESMTP",
            starttls: false,
            rcpt: "250 2.1.5 OK",
            final_reply: Some("250 2.0.0 OK queued"),
        }
    }
}

struct FakeMx {
    port: u16,
    commands: Arc<Mutex<Vec<String>>>,
    messages: Arc<Mutex<Vec<Vec<u8>>>>,
    connections: Arc<AtomicUsize>,
}

async fn start_mx(ip: &str, port: u16, script: Script) -> FakeMx {
    let l = TcpListener::bind((ip, port)).await.unwrap();
    let port = l.local_addr().unwrap().port();
    let (commands, messages, connections) =
        (Arc::new(Mutex::new(vec![])), Arc::new(Mutex::new(vec![])), Arc::new(AtomicUsize::new(0)));
    let (c2, m2, n2) = (commands.clone(), messages.clone(), connections.clone());
    tokio::spawn(async move {
        loop {
            let Ok((s, _)) = l.accept().await else { return };
            n2.fetch_add(1, Ordering::SeqCst);
            let (cmds, msgs, sc) = (c2.clone(), m2.clone(), script.clone());
            tokio::spawn(async move {
                let (rd, mut wr) = s.into_split();
                let mut rd = BufReader::new(rd);
                let _ = wr.write_all(format!("{}\r\n", sc.greeting).as_bytes()).await;
                if !sc.greeting.starts_with("220") {
                    return;
                }
                let mut line = String::new();
                loop {
                    line.clear();
                    if rd.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let cmd = line.trim_end().to_string();
                    cmds.lock().unwrap().push(cmd.clone());
                    let up = cmd.to_ascii_uppercase();
                    let reply: String = if up.starts_with("EHLO") {
                        if sc.starttls {
                            "250-mx.test\r\n250-PIPELINING\r\n250 STARTTLS".into()
                        } else {
                            "250-mx.test\r\n250 8BITMIME".into()
                        }
                    } else if up == "STARTTLS" {
                        // Accept, then break the handshake with garbage.
                        let _ = wr.write_all(b"220 go ahead\r\n").await;
                        let _ = wr.write_all(b"this is not TLS\r\n").await;
                        return;
                    } else if up.starts_with("MAIL") {
                        "250 2.1.0 OK".into()
                    } else if up.starts_with("RCPT") {
                        sc.rcpt.into()
                    } else if up == "DATA" {
                        let _ = wr.write_all(b"354 go\r\n").await;
                        let mut data = Vec::new();
                        loop {
                            line.clear();
                            if rd.read_line(&mut line).await.unwrap_or(0) == 0 {
                                return;
                            }
                            if line == ".\r\n" {
                                break;
                            }
                            let l2 = line.strip_prefix('.').unwrap_or(&line);
                            data.extend_from_slice(l2.as_bytes());
                        }
                        msgs.lock().unwrap().push(data);
                        match sc.final_reply {
                            Some(r) => r.into(),
                            None => return,
                        }
                    } else if up == "QUIT" {
                        let _ = wr.write_all(b"221 bye\r\n").await;
                        return;
                    } else {
                        "250 OK".into()
                    };
                    let _ = wr.write_all(format!("{reply}\r\n").as_bytes()).await;
                }
            });
        }
    });
    FakeMx { port, commands, messages, connections }
}

// ---------------- helpers ----------------

fn dkim() -> Arc<Dkim> {
    static K: OnceLock<Arc<Dkim>> = OnceLock::new();
    K.get_or_init(|| {
        let (pem, _) = raxo_email::dkim::generate_rsa_2048().unwrap();
        let key = raxo_email::dkim::parse_private_key_pem(&pem).unwrap();
        Arc::new(Dkim::from_private_key("btctoons.com", "raxo1", key).unwrap())
    })
    .clone()
}

fn cfg(port: u16, dns: FakeDns, dkim: Option<Arc<Dkim>>) -> SmtpConfig {
    SmtpConfig {
        mode: DeliveryMode::Direct,
        helo_name: "mail.btctoons.com".into(),
        direct_port: port,
        timeout: Duration::from_secs(5),
        dkim,
        resolver: Some(Arc::new(dns)),
        ..Default::default()
    }
}

fn message() -> Vec<u8> {
    b"Message-ID: <t1@btctoons.com>\r\nDate: Thu, 12 Nov 2026 05:00:00 +0100\r\nFrom: forms@btctoons.com\r\n\
To: owner@dest.test\r\nSubject: Hello\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n\
Line one\r\n.leading dot\r\n"
        .to_vec()
}

/// In-memory TXT cache so mail-auth verification never touches the network.
struct KeyCache(HashMap<Box<str>, TxtRecord>);

impl ResolverCache<Box<str>, TxtRecord> for KeyCache {
    fn get<Q>(&self, name: &Q) -> Option<TxtRecord>
    where
        Box<str>: std::borrow::Borrow<Q>,
        Q: std::hash::Hash + Eq + ?Sized,
    {
        self.0.get(name).cloned()
    }
    fn remove<Q>(&self, _: &Q) -> Option<TxtRecord>
    where
        Box<str>: std::borrow::Borrow<Q>,
        Q: std::hash::Hash + Eq + ?Sized,
    {
        None
    }
    fn insert(&self, _: Box<str>, _: TxtRecord, _: std::time::Instant) {}
}

impl DnsCache for KeyCache {
    type Txt = KeyCache;
    type Mx = NoCache;
    type Ipv4 = NoCache;
    type Ipv6 = NoCache;
    type Ptr = NoCache;
    fn txt(&self) -> Option<&KeyCache> {
        Some(self)
    }
    fn mx(&self) -> Option<&NoCache> {
        None
    }
    fn ipv4(&self) -> Option<&NoCache> {
        None
    }
    fn ipv6(&self) -> Option<&NoCache> {
        None
    }
    fn ptr(&self) -> Option<&NoCache> {
        None
    }
}

async fn verify(d: &Dkim, raw: &[u8]) -> Vec<DkimResult> {
    let key = DomainKey::parse(d.dns_value().as_bytes()).unwrap();
    let mut m = HashMap::new();
    m.insert(format!("{}.", d.dns_name()).into_boxed_str(), TxtRecord::from(key));
    let cache = KeyCache(m);
    let auth = MessageAuthenticator::new_cloudflare().unwrap();
    let msg = AuthenticatedMessage::parse(raw).unwrap();
    auth.verify_dkim(Parameters::new(&msg).with_cache(&cache)).await.iter().map(|o| o.result().clone()).collect()
}

// ---------------- tests ----------------

#[tokio::test]
async fn dkim_signature_verifies_and_detects_tampering() {
    let d = dkim();
    let signed = d.sign(&message()).unwrap();
    let text = String::from_utf8_lossy(&signed);
    assert!(text.starts_with("DKIM-Signature:"));
    assert!(text.ends_with(std::str::from_utf8(&message()).unwrap()), "stored bytes are not altered");
    let sig = text.split("\r\n\r\n").next().unwrap().replace("\r\n", "").replace([' ', '\t'], "");
    assert!(sig.contains("a=rsa-sha256") && sig.contains("c=relaxed/relaxed") && sig.contains("d=btctoons.com"));
    let h = sig.split("h=").nth(1).unwrap().split(';').next().unwrap().to_ascii_lowercase();
    assert_eq!(h.split(':').filter(|x| *x == "from").count(), 2, "From must be over-signed: {h}");
    for want in ["to", "subject", "date", "message-id", "mime-version", "content-type", "reply-to", "cc"] {
        assert!(h.split(':').any(|x| x == want), "{want} missing from h={h}");
    }
    assert_eq!(verify(&d, &signed).await, vec![DkimResult::Pass]);

    let tampered = String::from_utf8(signed.clone()).unwrap().replace("Subject: Hello", "Subject: Hellp");
    assert!(matches!(verify(&d, tampered.as_bytes()).await[..], [DkimResult::Fail(_)]));
    let added_from = String::from_utf8(signed).unwrap().replace("To: owner", "From: evil@x.test\r\nTo: owner");
    assert!(matches!(verify(&d, added_from.as_bytes()).await[..], [DkimResult::Fail(_)]));
}

#[tokio::test]
async fn pkcs1_and_pkcs8_keys_load_from_file() {
    use rsa::pkcs1::EncodeRsaPrivateKey;
    let dir = tempfile::tempdir().unwrap();
    let (pem8, public) = raxo_email::dkim::generate_rsa_2048().unwrap();
    let key = raxo_email::dkim::parse_private_key_pem(&pem8).unwrap();
    let pem1 = key.to_pkcs1_pem(rsa::pkcs8::LineEnding::LF).unwrap();
    for (name, pem) in [("k8.pem", pem8.as_str()), ("k1.pem", pem1.as_str())] {
        let p = dir.path().join(name);
        std::fs::write(&p, pem).unwrap();
        let d = Dkim::load("BTCtoons.com.", "s1", &p).unwrap();
        assert_eq!(d.public_key(), &public);
        assert_eq!(d.domain(), "btctoons.com");
        assert_eq!(raxo_email::dkim::parse_dns_public_key(&d.dns_value()).unwrap(), public);
        assert!(!format!("{d:?}").contains("BEGIN"));
    }
    let bad = dir.path().join("bad.pem");
    std::fs::write(&bad, "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n").unwrap();
    assert!(Dkim::load("btctoons.com", "s1", &bad).is_err());
    assert!(Dkim::load("btctoons.com", "s1", &dir.path().join("missing.pem")).is_err());
}

#[tokio::test]
async fn direct_delivery_success_is_signed_and_receipted() {
    let mx = start_mx("127.0.0.1", 0, Script::default()).await;
    let dns = FakeDns::default().mx("dest.test", &[(10, "mx1.dest.test")]).a("mx1.dest.test", "127.0.0.1");
    let d = dkim();
    let r = submit_raw(&message(), "forms@btctoons.com", "owner@dest.test", &cfg(mx.port, dns, Some(d.clone()))).await;
    let SubmitResult::Submitted { ref info, .. } = r else { panic!("expected submitted, got {r:?}") };
    assert_eq!(info.mx_host.as_deref(), Some("mx1.dest.test"));
    let receipt = r.receipt().unwrap();
    assert_eq!(receipt["mx_host"], "mx1.dest.test");
    assert_eq!(receipt["tls"], "none");
    assert_eq!(receipt["delivery"], "direct");
    assert_eq!(receipt["dkim"]["d"], "btctoons.com");

    let cmds = mx.commands.lock().unwrap().clone();
    assert_eq!(cmds[0], "EHLO mail.btctoons.com");
    assert!(cmds.iter().all(|c| !c.to_ascii_uppercase().starts_with("AUTH")));
    assert!(cmds.contains(&"RCPT TO:<owner@dest.test>".to_string()));
    let delivered = mx.messages.lock().unwrap()[0].clone();
    assert!(String::from_utf8_lossy(&delivered).contains("\r\n.leading dot\r\n"));
    assert_eq!(verify(&d, &delivered).await, vec![DkimResult::Pass]);
}

#[tokio::test]
async fn rcpt_5xx_is_permanent_failure_without_data() {
    let mx = start_mx("127.0.0.1", 0, Script { rcpt: "550 5.1.1 no such user", ..Default::default() }).await;
    let dns = FakeDns::default().mx("dest.test", &[(10, "mx1.dest.test")]).a("mx1.dest.test", "127.0.0.1");
    let r = submit_raw(&message(), "forms@btctoons.com", "owner@dest.test", &cfg(mx.port, dns, None)).await;
    assert_eq!(r, SubmitResult::Failed("smtp_550".into()));
    assert!(!mx.commands.lock().unwrap().iter().any(|c| c == "DATA"));
}

#[tokio::test]
async fn rcpt_4xx_is_safe_retry() {
    let mx = start_mx("127.0.0.1", 0, Script { rcpt: "451 4.7.1 greylisted", ..Default::default() }).await;
    let dns = FakeDns::default().mx("dest.test", &[(10, "mx1.dest.test")]).a("mx1.dest.test", "127.0.0.1");
    let r = submit_raw(&message(), "forms@btctoons.com", "owner@dest.test", &cfg(mx.port, dns, None)).await;
    assert_eq!(r, SubmitResult::SafeRetry("smtp_451".into()));
    assert!(mx.messages.lock().unwrap().is_empty());
}

#[tokio::test]
async fn unreachable_and_4xx_greeting_hosts_fall_through_to_next_mx() {
    let good = start_mx("127.0.0.1", 0, Script::default()).await;
    // Same port on another loopback address: busy MX answering 421.
    let busy = start_mx("127.0.0.2", good.port, Script { greeting: "421 4.3.2 busy", ..Default::default() }).await;
    let dns = FakeDns::default()
        .mx("dest.test", &[(30, "good.dest.test"), (10, "dead.dest.test"), (20, "busy.dest.test")])
        .a("dead.dest.test", "127.0.0.3")
        .a("busy.dest.test", "127.0.0.2")
        .a("good.dest.test", "127.0.0.1");
    let r = submit_raw(&message(), "forms@btctoons.com", "owner@dest.test", &cfg(good.port, dns, None)).await;
    assert_eq!(r.receipt().unwrap()["mx_host"], "good.dest.test", "{r:?}");
    assert_eq!(busy.connections.load(Ordering::SeqCst), 1);
    assert_eq!(good.messages.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn all_hosts_temporarily_unavailable_is_safe_retry() {
    let busy = start_mx("127.0.0.1", 0, Script { greeting: "421 4.3.2 busy", ..Default::default() }).await;
    let dns = FakeDns::default().mx("dest.test", &[(10, "mx1.dest.test")]).a("mx1.dest.test", "127.0.0.1");
    let r = submit_raw(&message(), "forms@btctoons.com", "owner@dest.test", &cfg(busy.port, dns, None)).await;
    assert!(matches!(r, SubmitResult::SafeRetry(_)), "{r:?}");
}

#[tokio::test]
async fn failed_starttls_handshake_retries_same_host_in_plaintext() {
    let mx = start_mx("127.0.0.1", 0, Script { starttls: true, ..Default::default() }).await;
    let dns = FakeDns::default().mx("dest.test", &[(10, "mx1.dest.test")]).a("mx1.dest.test", "127.0.0.1");
    let r = submit_raw(&message(), "forms@btctoons.com", "owner@dest.test", &cfg(mx.port, dns, None)).await;
    assert_eq!(r.receipt().unwrap()["tls"], "none", "{r:?}");
    assert_eq!(mx.connections.load(Ordering::SeqCst), 2);
    assert_eq!(mx.commands.lock().unwrap().iter().filter(|c| *c == "STARTTLS").count(), 1);
}

#[tokio::test]
async fn missing_final_reply_after_data_is_unknown() {
    let mx = start_mx("127.0.0.1", 0, Script { final_reply: None, ..Default::default() }).await;
    let dns = FakeDns::default().mx("dest.test", &[(10, "mx1.dest.test")]).a("mx1.dest.test", "127.0.0.1");
    let r = submit_raw(&message(), "forms@btctoons.com", "owner@dest.test", &cfg(mx.port, dns, None)).await;
    assert!(matches!(r, SubmitResult::Unknown(_)), "{r:?}");
}

#[tokio::test]
async fn null_mx_nxdomain_and_implicit_mx() {
    let mx = start_mx("127.0.0.1", 0, Script::default()).await;
    let mut dns = FakeDns::default().mx("null.test", &[(0, ".")]).a("implicit.test", "127.0.0.1");
    dns.mx.insert("implicit.test".into(), DnsAnswer::NoRecords);
    dns.mx.insert("noaddr.test".into(), DnsAnswer::NoRecords);
    dns.a.insert("noaddr.test".into(), DnsAnswer::NoRecords);
    dns.mx.insert("flaky.test".into(), DnsAnswer::TempFail("SERVFAIL".into()));
    let c = cfg(mx.port, dns, None);
    let send = |to: &'static str| submit_raw(b"From: a@b.test\r\n\r\nx\r\n", "a@b.test", to, &c);
    assert_eq!(send("u@null.test").await, SubmitResult::Failed("null_mx".into()));
    assert_eq!(send("u@nxdomain.test").await, SubmitResult::Failed("dns_nxdomain".into()));
    assert_eq!(send("u@noaddr.test").await, SubmitResult::Failed("no_mx_or_address".into()));
    assert_eq!(send("u@flaky.test").await, SubmitResult::SafeRetry("dns_tempfail".into()));
    assert_eq!(mx.connections.load(Ordering::SeqCst), 0);
    let r = send("u@implicit.test").await;
    assert_eq!(r.receipt().unwrap()["mx_host"], "implicit.test", "{r:?}");
}
