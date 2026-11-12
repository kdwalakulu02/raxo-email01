//! Public frontend assets compiled into the binary. Only names listed here are served.

macro_rules! asset {
    ($name:literal, $mime:literal) => {
        ($name, $mime, include_bytes!(concat!("../web/", $name)) as &[u8])
    };
}

const ASSETS: &[(&str, &str, &[u8])] = &[
    asset!("styles.css", "text/css; charset=utf-8"),
    asset!("app.js", "text/javascript; charset=utf-8"),
    asset!("assets/arrow.svg", "image/svg+xml"),
    asset!("assets/backend.svg", "image/svg+xml"),
    asset!("assets/chat.svg", "image/svg+xml"),
    asset!("assets/feature-lock.svg", "image/svg+xml"),
    asset!("assets/feature-scan.svg", "image/svg+xml"),
    asset!("assets/feature-server.svg", "image/svg+xml"),
    asset!("assets/feature-shield.svg", "image/svg+xml"),
    asset!("assets/feature-verified.svg", "image/svg+xml"),
    asset!("assets/hero-art.webp", "image/webp"),
    asset!("assets/lock.svg", "image/svg+xml"),
    asset!("assets/logo.svg", "image/svg+xml"),
    asset!("assets/panel-lock.svg", "image/svg+xml"),
    asset!("assets/panel-scan.svg", "image/svg+xml"),
    asset!("assets/problem-email.svg", "image/svg+xml"),
    asset!("assets/problem-file.svg", "image/svg+xml"),
    asset!("assets/problem-private.svg", "image/svg+xml"),
    asset!("assets/problem-server.svg", "image/svg+xml"),
    asset!("assets/scan.svg", "image/svg+xml"),
    asset!("assets/setup-code.svg", "image/svg+xml"),
    asset!("assets/setup-email.svg", "image/svg+xml"),
    asset!("assets/setup-shield.svg", "image/svg+xml"),
    asset!("assets/step-inbox.svg", "image/svg+xml"),
    asset!("assets/step-processing.svg", "image/svg+xml"),
    asset!("assets/step-website.svg", "image/svg+xml"),
    asset!("assets/submission.svg", "image/svg+xml"),
    asset!("assets/workflow.svg", "image/svg+xml"),
];

pub const INDEX_TEMPLATE: &str = include_str!("../web/index.html");

/// Resolves a public `/assets/{name}` request to its MIME type and bytes.
pub fn asset(name: &str) -> Option<(&'static str, &'static [u8])> {
    ASSETS.iter().find(|(path, _, _)| path.rsplit('/').next() == Some(name)).map(|(_, mime, bytes)| (*mime, *bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_only_allowlisted_assets() {
        let (mime, bytes) = asset("logo.svg").unwrap();
        assert_eq!(mime, "image/svg+xml");
        assert!(!bytes.is_empty());
        assert_eq!(asset("styles.css").unwrap().0, "text/css; charset=utf-8");
        for bad in ["", "index.html", "../Cargo.toml", "assets/logo.svg", "..%2fsrc%2fweb.rs", "hero-original.webp"] {
            assert!(asset(bad).is_none(), "{bad} must not be served");
        }
    }

    #[test]
    fn template_references_only_embedded_assets() {
        for part in INDEX_TEMPLATE.split("/assets/").skip(1) {
            let name = part.split(['"', '?']).next().unwrap();
            assert!(asset(name).is_some(), "missing embedded asset {name}");
        }
    }
}
