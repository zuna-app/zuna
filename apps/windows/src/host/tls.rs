//! Certificates. A server reached by its IP address makes its own certificate, and is
//! trusted by its pin from its links (`pinServer`), and by nothing else; every other
//! certificate is the system's roots to judge. As PinnedServers.swift does on iOS.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::{Arc, LazyLock};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use parking_lot::RwLock;
use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use sha2::{Digest, Sha256};

static PINS: LazyLock<RwLock<HashMap<String, HashSet<String>>>> = LazyLock::new(Default::default);

/// An address as a host name, with an IPv6 one out of its brackets.
fn bare(host: &str) -> &str {
    host.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')).unwrap_or(host)
}

/// Only an address over HTTPS can have a pin (`checkPinnable` in the core), never a
/// name, so nothing can have the app trust another key for one.
pub fn add_pin(address: &str, pin: &str) -> bool {
    let Ok(url) = url::Url::parse(address) else { return false };
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    let host = bare(host);
    if host.parse::<IpAddr>().is_err() {
        return false;
    }
    if pin.len() != 43 || !pin.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return false;
    }
    PINS.write().entry(host.to_string()).or_default().insert(pin.to_string());
    true
}

/// The SHA-256 of a certificate's SubjectPublicKeyInfo, in base64url, as links carry it.
fn pin_of(certificate: &CertificateDer<'_>) -> Option<String> {
    let (_, parsed) = x509_parser::parse_x509_certificate(certificate.as_ref()).ok()?;
    let digest = Sha256::digest(parsed.tbs_certificate.subject_pki.raw);
    Some(URL_SAFE_NO_PAD.encode(digest))
}

#[derive(Debug)]
struct Verifier {
    roots: Arc<WebPkiServerVerifier>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let host = match server_name {
            ServerName::IpAddress(address) => IpAddr::from(*address).to_string(),
            ServerName::DnsName(name) => name.as_ref().to_string(),
            _ => String::new(),
        };
        let wanted = PINS.read().get(bare(&host)).cloned();
        match wanted {
            Some(wanted) => match pin_of(end_entity) {
                Some(pin) if wanted.contains(&pin) => Ok(ServerCertVerified::assertion()),
                _ => Err(rustls::Error::General("The server's certificate doesn't match its pin.".into())),
            },
            None => self.roots.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn roots() -> RootCertStore {
    let mut roots = RootCertStore::empty();
    // The system's own roots, so a server behind a private authority works as it does in a browser.
    let native = rustls_native_certs::load_native_certs();
    for certificate in native.certs {
        roots.add(certificate).ok();
    }
    // And Mozilla's, as Windows only keeps the public roots it has needed so far and
    // fetches the rest while building a chain, which rustls doesn't ask it to.
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    roots
}

static VERIFIER: LazyLock<Arc<Verifier>> = LazyLock::new(|| {
    let provider = provider();
    let roots = WebPkiServerVerifier::builder_with_provider(Arc::new(roots()), provider.clone())
        .build()
        .expect("the system's roots make a verifier");
    Arc::new(Verifier { roots, provider })
});

/// TLS for the core's requests and sockets, speaking these protocols.
pub fn client_config(alpn: &[&[u8]]) -> ClientConfig {
    let mut config = ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(VERIFIER.clone())
        .with_no_client_auth();
    config.alpn_protocols = alpn.iter().map(|protocol| protocol.to_vec()).collect();
    config
}
