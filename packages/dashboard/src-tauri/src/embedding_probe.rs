//! OpenAI-compatible embedding endpoint probe + literal config-token detection.
//!
//! Mirrors the Node implementations in
//!   packages/plugin/src/features/magic-context/memory/embedding-probe.ts
//!
//! The dashboard intentionally does not expand `{env:...}` or `{file:...}`
//! values before probing a user-provided endpoint: expanding secrets and then
//! sending them to that endpoint would allow one-click exfiltration from the UI.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::Path;
use std::time::Duration;

use serde::Serialize;

/// Structured probe outcome. Matches the kinds produced by the Node probe so
/// frontend messaging can key off the same categories.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EmbeddingProbeOutcome {
    /// 2xx with a valid `data[0].embedding` float array.
    Ok {
        status: u16,
        dimensions: Option<usize>,
    },
    /// 401 / 403 — credentials rejected.
    AuthFailed { status: u16, preview: String },
    /// 404 / 405 or 2xx without an embedding body — endpoint doesn't serve
    /// embeddings (wrong URL, or provider doesn't offer the API).
    EndpointUnsupported { status: u16, preview: String },
    /// Other non-2xx status.
    HttpError { status: u16, preview: String },
    /// Connection failed, DNS failed, TLS failed, etc.
    NetworkError { message: String },
    /// Request took longer than `timeout_ms`.
    Timeout { timeout_ms: u64 },
    /// Endpoint URL is missing or is not HTTPS.
    InvalidScheme { endpoint: String },
    /// Config contains `{env:VAR}` / `{file:path}` tokens. The dashboard
    /// refuses to expand those tokens before contacting a user-supplied
    /// endpoint, because doing so could leak local secrets.
    UnresolvedToken {
        /// Which field carries the token (e.g., "api_key", "endpoint").
        field: String,
        /// The unresolved token (e.g., "{env:EMBED_KEY}"). Safe to surface —
        /// users need to know which var is missing.
        token: String,
    },
}

/// Options passed to the Rust probe. Mirrors the Node `EmbeddingProbeOptions`.
#[derive(Debug, Clone)]
pub struct EmbeddingProbeOptions {
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
    /// Optional `input_type` body field — required by some providers (NVIDIA NIM).
    pub input_type: Option<String>,
    /// Optional `truncate` body field (e.g. NVIDIA NIM).
    pub truncate: Option<String>,
    pub timeout_ms: u64,
}

const MAX_PREVIEW_CHARS: usize = 240;

/// Return the first `{env:VAR}` or `{file:path}` token embedded in a value.
///
/// The dashboard probe treats these tokens as unresolved instead of expanding
/// them. Expanding `{file:...}` or `{env:...}` and then sending the result to a
/// user-configured endpoint would let a malicious project config exfiltrate
/// local secrets through the one-click “Test embedding endpoint” button.
pub fn find_substitution_token(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{'
            && (bytes[i..].starts_with(b"{env:") || bytes[i..].starts_with(b"{file:"))
        {
            if let Some(rel_end) = raw[i..].find('}') {
                return Some(raw[i..=i + rel_end].to_string());
            }
        }
        let ch = raw[i..].chars().next().expect("in-range char");
        i += ch.len_utf8();
    }
    None
}

/// Legacy helper kept for tests and callers that need token detection semantics.
/// It never resolves tokens to local file contents or environment values.
pub fn substitute_value(raw: &str, _config_dir: Option<&Path>) -> (String, Option<String>) {
    (raw.to_string(), find_substitution_token(raw))
}

/// POST `{model, input}` to `${endpoint}/embeddings` and classify the outcome.
pub async fn probe_embedding_endpoint(options: EmbeddingProbeOptions) -> EmbeddingProbeOutcome {
    let validated = match validate_probe_endpoint(&options.endpoint).await {
        Ok(endpoint) => endpoint,
        Err(outcome) => return outcome,
    };
    let url = format!("{}/embeddings", validated.endpoint);

    // `.no_proxy()` is deliberate: by default reqwest auto-detects macOS
    // / Windows system proxy settings, which produces a confusing failure
    // mode where `doctor` works (Node's fetch ignores system proxies and
    // only honors HTTP_PROXY/HTTPS_PROXY env vars) but the dashboard
    // tries to route the same localhost URL through whatever the user
    // has configured in System Settings → Network → Proxies. Setting
    // no_proxy() here aligns the dashboard probe with Node's behavior so
    // both surfaces classify the same endpoint the same way. Users who
    // genuinely want to route embedding traffic through a proxy can
    // expose that as an explicit config field later if needed.
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(options.timeout_ms))
        .no_proxy()
        // Pin reqwest to the public addresses we already validated so DNS
        // cannot re-resolve the hostname to a private or metadata address after
        // the SSRF guard has passed.
        .resolve_to_addrs(&validated.host, &validated.addrs)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return EmbeddingProbeOutcome::NetworkError {
                message: format!("Failed to create HTTP client: {}", e),
            };
        }
    };

    let mut body = serde_json::json!({
        "model": options.model,
        "input": "magic-context probe",
    });
    // Optional provider-specific fields (e.g. NVIDIA NIM requires input_type).
    // Added only when set so standard OpenAI endpoints are unaffected.
    if let Some(map) = body.as_object_mut() {
        if let Some(input_type) = options
            .input_type
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            map.insert(
                "input_type".to_string(),
                serde_json::Value::String(input_type.to_string()),
            );
        }
        if let Some(truncate) = options
            .truncate
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            map.insert(
                "truncate".to_string(),
                serde_json::Value::String(truncate.to_string()),
            );
        }
    }

    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body);

    if let Some(key) = options.api_key.as_deref() {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", trimmed));
        }
    }

    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            // reqwest marks timeouts specifically — surface them so the user
            // gets actionable "check endpoint URL / network" wording rather
            // than the generic connection-failed message.
            if e.is_timeout() {
                return EmbeddingProbeOutcome::Timeout {
                    timeout_ms: options.timeout_ms,
                };
            }
            return EmbeddingProbeOutcome::NetworkError {
                // reqwest's Display only renders the top-level message
                // (`error sending request for url (...)`) and drops the
                // underlying cause. Walk the source chain so users see the
                // actual failure (connection refused, DNS, TLS handshake,
                // etc.) instead of just the URL.
                message: format_error_with_causes(&e),
            };
        }
    };

    let status = response.status();
    let status_u16 = status.as_u16();

    if status.is_success() {
        // Parse body and verify shape. OpenRouter, for example, may return
        // 200 with a chat-style body when the embeddings route is not
        // supported — we want to catch that instead of reporting success.
        let body_text = response.text().await.unwrap_or_default();
        let parsed: Result<serde_json::Value, _> = serde_json::from_str(&body_text);
        let preview = truncate_preview(&body_text);
        match parsed {
            Ok(value) => match extract_dimensions(&value) {
                Some(dims) => EmbeddingProbeOutcome::Ok {
                    status: status_u16,
                    dimensions: Some(dims),
                },
                None => EmbeddingProbeOutcome::EndpointUnsupported {
                    status: status_u16,
                    preview,
                },
            },
            Err(_) => {
                // 2xx but non-JSON body — definitely not an embeddings response.
                EmbeddingProbeOutcome::EndpointUnsupported {
                    status: status_u16,
                    preview,
                }
            }
        }
    } else {
        let body_text = response.text().await.unwrap_or_default();
        let preview = truncate_preview(&body_text);
        match status_u16 {
            401 | 403 => EmbeddingProbeOutcome::AuthFailed {
                status: status_u16,
                preview,
            },
            404 | 405 => EmbeddingProbeOutcome::EndpointUnsupported {
                status: status_u16,
                preview,
            },
            _ => EmbeddingProbeOutcome::HttpError {
                status: status_u16,
                preview,
            },
        }
    }
}

struct ValidatedEndpoint {
    endpoint: String,
    host: String,
    addrs: Vec<SocketAddr>,
}

async fn validate_probe_endpoint(
    raw_endpoint: &str,
) -> Result<ValidatedEndpoint, EmbeddingProbeOutcome> {
    let endpoint = raw_endpoint.trim().trim_end_matches('/').to_string();
    let parsed = match reqwest::Url::parse(&endpoint) {
        Ok(url) => url,
        Err(_) => {
            return Err(EmbeddingProbeOutcome::InvalidScheme {
                endpoint: raw_endpoint.to_string(),
            });
        }
    };

    if parsed.scheme() != "https" {
        return Err(EmbeddingProbeOutcome::InvalidScheme {
            endpoint: raw_endpoint.to_string(),
        });
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(EmbeddingProbeOutcome::NetworkError {
            message: "Embedding endpoint URLs must not include usernames or passwords".to_string(),
        });
    }
    let Some(host) = parsed.host_str().map(str::to_string) else {
        return Err(EmbeddingProbeOutcome::InvalidScheme {
            endpoint: raw_endpoint.to_string(),
        });
    };
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = match tokio::net::lookup_host((host.as_str(), port)).await {
        Ok(iter) => iter.collect(),
        Err(e) => {
            return Err(EmbeddingProbeOutcome::NetworkError {
                message: format!("Failed to resolve embedding endpoint host: {e}"),
            });
        }
    };
    if addrs.is_empty() {
        return Err(EmbeddingProbeOutcome::NetworkError {
            message: "Embedding endpoint host resolved to no addresses".to_string(),
        });
    }
    if let Some(blocked) = addrs.iter().find(|addr| is_disallowed_probe_ip(addr.ip())) {
        return Err(EmbeddingProbeOutcome::NetworkError {
            message: format!(
                "Embedding endpoint host resolves to a private, local, or metadata address ({}) and was blocked",
                blocked.ip()
            ),
        });
    }

    Ok(ValidatedEndpoint {
        endpoint,
        host,
        addrs,
    })
}

fn is_disallowed_probe_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_disallowed_probe_ipv4(ip),
        IpAddr::V6(ip) => is_disallowed_probe_ipv6(ip),
    }
}

fn is_disallowed_probe_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.octets()[0] == 0
}

fn is_disallowed_probe_ipv6(ip: Ipv6Addr) -> bool {
    ip.is_loopback()
        || ip.is_unspecified()
        || is_unique_local_ipv6(ip)
        || is_unicast_link_local_ipv6(ip)
}

fn is_unique_local_ipv6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

fn is_unicast_link_local_ipv6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

fn extract_dimensions(body: &serde_json::Value) -> Option<usize> {
    let data = body.get("data")?.as_array()?;
    let first = data.first()?;
    let embedding = first.get("embedding")?.as_array()?;
    if embedding.is_empty() {
        return None;
    }
    // Defensive: first entry must parse as a finite number.
    let sample = embedding.first()?.as_f64()?;
    if !sample.is_finite() {
        return None;
    }
    Some(embedding.len())
}

/// Walk a reqwest error's source chain so the user sees the underlying
/// cause (`connection refused`, `dns error: failed to lookup ...`,
/// `tls handshake eof`) instead of only the top-level `error sending
/// request for url (...)` message. Limited to 5 levels of depth as a
/// safety bound — reqwest errors typically only carry 1–2 sources.
fn format_error_with_causes(err: &(dyn std::error::Error + 'static)) -> String {
    let mut parts = vec![err.to_string()];
    let mut current = err.source();
    let mut depth = 0;
    while let Some(cause) = current {
        if depth >= 5 {
            break;
        }
        let cause_str = cause.to_string();
        // Skip empty causes and de-duplicate against the immediately
        // preceding part — reqwest occasionally wraps the same message
        // at multiple layers and we'd rather not surface it twice.
        if !cause_str.is_empty() && parts.last().map(|p| p.as_str()) != Some(cause_str.as_str()) {
            parts.push(cause_str);
        }
        current = cause.source();
        depth += 1;
    }
    parts.join(": ")
}

fn truncate_preview(text: &str) -> String {
    // Char-safe truncation so multi-byte bodies don't panic.
    let mut buf = String::with_capacity(MAX_PREVIEW_CHARS.min(text.len()));
    for (i, ch) in text.chars().enumerate() {
        if i >= MAX_PREVIEW_CHARS {
            buf.push('…');
            return buf;
        }
        buf.push(ch);
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitute_leaves_text_without_tokens_untouched() {
        let (out, residual) = substitute_value("plain value", None);
        assert_eq!(out, "plain value");
        assert!(residual.is_none());
    }

    #[test]
    fn substitute_reports_env_tokens_without_resolving() {
        std::env::set_var("MC_TEST_SUBST_KEY", "resolved-value");
        let raw = "prefix-{env:MC_TEST_SUBST_KEY}-suffix";
        let (out, residual) = substitute_value(raw, None);
        assert_eq!(out, raw);
        assert_eq!(residual.as_deref(), Some("{env:MC_TEST_SUBST_KEY}"));
        std::env::remove_var("MC_TEST_SUBST_KEY");
    }

    #[test]
    fn substitute_reports_unresolved_env_tokens() {
        std::env::remove_var("MC_TEST_NONEXISTENT_VAR_FOR_PROBE");
        let (out, residual) = substitute_value("{env:MC_TEST_NONEXISTENT_VAR_FOR_PROBE}", None);
        // Tokens are preserved so the caller can refuse to expand them.
        assert_eq!(out, "{env:MC_TEST_NONEXISTENT_VAR_FOR_PROBE}");
        assert_eq!(
            residual.as_deref(),
            Some("{env:MC_TEST_NONEXISTENT_VAR_FOR_PROBE}")
        );
    }

    #[test]
    fn substitute_trims_env_var_name_whitespace() {
        std::env::set_var("MC_TEST_SUBST_TRIM", "trimmed");
        let raw = "{env: MC_TEST_SUBST_TRIM }";
        let (out, residual) = substitute_value(raw, None);
        assert_eq!(out, raw);
        assert_eq!(residual.as_deref(), Some(raw));
        std::env::remove_var("MC_TEST_SUBST_TRIM");
    }

    #[test]
    fn substitute_handles_empty_env_value_as_unresolved() {
        std::env::set_var("MC_TEST_EMPTY_VAR", "");
        let (out, residual) = substitute_value("{env:MC_TEST_EMPTY_VAR}", None);
        assert_eq!(out, "{env:MC_TEST_EMPTY_VAR}");
        assert_eq!(residual.as_deref(), Some("{env:MC_TEST_EMPTY_VAR}"));
        std::env::remove_var("MC_TEST_EMPTY_VAR");
    }

    #[test]
    fn substitute_preserves_file_tokens_without_reading() {
        let tmp_dir = std::env::temp_dir();
        let tmp_path = tmp_dir.join("mc-embedding-probe-test.txt");
        std::fs::write(&tmp_path, "file-contents-here").unwrap();
        let raw = format!("{{file:{}}}", tmp_path.display());
        let (out, residual) = substitute_value(&raw, None);
        assert_eq!(out, raw);
        assert_eq!(residual.as_deref(), Some(raw.as_str()));
        std::fs::remove_file(&tmp_path).ok();
    }

    #[test]
    fn substitute_reports_missing_files() {
        let (out, residual) = substitute_value("{file:/no/such/file/path.txt}", None);
        assert_eq!(out, "{file:/no/such/file/path.txt}");
        assert_eq!(residual.as_deref(), Some("{file:/no/such/file/path.txt}"));
    }

    #[test]
    fn substitute_handles_multiple_tokens_preserving_order() {
        std::env::set_var("MC_TEST_TOK_A", "A");
        std::env::set_var("MC_TEST_TOK_B", "B");
        let raw = "start-{env:MC_TEST_TOK_A}-mid-{env:MC_TEST_TOK_B}-end";
        let (out, residual) = substitute_value(raw, None);
        assert_eq!(out, raw);
        assert_eq!(residual.as_deref(), Some("{env:MC_TEST_TOK_A}"));
        std::env::remove_var("MC_TEST_TOK_A");
        std::env::remove_var("MC_TEST_TOK_B");
    }

    #[test]
    fn extract_dimensions_accepts_valid_embedding() {
        let body = serde_json::json!({
            "data": [
                {
                    "embedding": [0.1, 0.2, 0.3, 0.4, 0.5]
                }
            ]
        });
        assert_eq!(extract_dimensions(&body), Some(5));
    }

    #[test]
    fn extract_dimensions_rejects_chat_style_body() {
        // OpenRouter would return something like this — 200 OK but not an
        // embeddings response. We classify as endpoint_unsupported.
        let body = serde_json::json!({
            "choices": [{
                "message": {"role": "assistant", "content": "hello"}
            }]
        });
        assert!(extract_dimensions(&body).is_none());
    }

    #[test]
    fn extract_dimensions_rejects_empty_array() {
        let body = serde_json::json!({"data": []});
        assert!(extract_dimensions(&body).is_none());
    }

    #[test]
    fn extract_dimensions_rejects_non_numeric_embedding() {
        let body = serde_json::json!({
            "data": [{"embedding": ["not", "a", "number"]}]
        });
        assert!(extract_dimensions(&body).is_none());
    }

    #[test]
    fn truncate_preview_caps_long_bodies() {
        let long_input = "a".repeat(500);
        let preview = truncate_preview(&long_input);
        assert!(preview.ends_with('…'));
        // MAX_PREVIEW_CHARS chars followed by the ellipsis.
        assert_eq!(preview.chars().count(), MAX_PREVIEW_CHARS + 1);
    }

    #[tokio::test]
    async fn probe_rejects_metadata_endpoint_before_connecting() {
        let outcome = probe_embedding_endpoint(EmbeddingProbeOptions {
            endpoint: "https://169.254.169.254/latest/meta-data".to_string(),
            model: "text-embedding-3-small".to_string(),
            api_key: Some("literal-key".to_string()),
            input_type: None,
            truncate: None,
            timeout_ms: 100,
        })
        .await;
        match outcome {
            EmbeddingProbeOutcome::NetworkError { message } => {
                assert!(message.contains("blocked"), "unexpected message: {message}");
                assert!(
                    message.contains("169.254.169.254"),
                    "unexpected message: {message}"
                );
            }
            other => panic!("expected blocked network error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn probe_rejects_loopback_endpoint_before_connecting() {
        let outcome = probe_embedding_endpoint(EmbeddingProbeOptions {
            endpoint: "https://127.0.0.1:4444".to_string(),
            model: "text-embedding-3-small".to_string(),
            api_key: None,
            input_type: None,
            truncate: None,
            timeout_ms: 100,
        })
        .await;
        assert!(matches!(
            outcome,
            EmbeddingProbeOutcome::NetworkError { .. }
        ));
    }

    #[tokio::test]
    async fn probe_rejects_credentials_in_endpoint_url() {
        let outcome = probe_embedding_endpoint(EmbeddingProbeOptions {
            endpoint: "https://user:pass@example.com".to_string(),
            model: "text-embedding-3-small".to_string(),
            api_key: None,
            input_type: None,
            truncate: None,
            timeout_ms: 100,
        })
        .await;
        match outcome {
            EmbeddingProbeOutcome::NetworkError { message } => {
                assert!(
                    message.contains("must not include"),
                    "unexpected message: {message}"
                );
            }
            other => panic!("expected credentials rejection, got {other:?}"),
        }
    }

    #[test]
    fn truncate_preview_leaves_short_bodies_intact() {
        let preview = truncate_preview("short");
        assert_eq!(preview, "short");
    }

    // ── format_error_with_causes ──────────────────────────────

    use std::error::Error;
    use std::fmt;

    /// Tiny error with a manually-controlled source chain so we can verify
    /// the formatter walks it correctly without needing reqwest internals.
    #[derive(Debug)]
    struct ChainErr {
        msg: &'static str,
        source: Option<Box<ChainErr>>,
    }
    impl fmt::Display for ChainErr {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(self.msg)
        }
    }
    impl Error for ChainErr {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            self.source.as_deref().map(|e| e as &(dyn Error + 'static))
        }
    }

    #[test]
    fn format_error_with_causes_joins_chain() {
        let inner = ChainErr {
            msg: "Connection refused (os error 61)",
            source: None,
        };
        let outer = ChainErr {
            msg: "error sending request for url (http://localhost:1234)",
            source: Some(Box::new(inner)),
        };
        let formatted = format_error_with_causes(&outer);
        assert_eq!(
            formatted,
            "error sending request for url (http://localhost:1234): Connection refused (os error 61)"
        );
    }

    #[test]
    fn format_error_with_causes_handles_single_level() {
        let only = ChainErr {
            msg: "standalone failure",
            source: None,
        };
        assert_eq!(format_error_with_causes(&only), "standalone failure");
    }

    #[test]
    fn format_error_with_causes_dedups_repeated_messages() {
        let inner = ChainErr {
            msg: "same message",
            source: None,
        };
        let outer = ChainErr {
            msg: "same message",
            source: Some(Box::new(inner)),
        };
        assert_eq!(format_error_with_causes(&outer), "same message");
    }

    #[tokio::test]
    async fn probe_detects_invalid_scheme() {
        let outcome = probe_embedding_endpoint(EmbeddingProbeOptions {
            endpoint: "example.com/v1".to_string(),
            model: "text-embedding-3-small".to_string(),
            api_key: None,
            input_type: None,
            truncate: None,
            timeout_ms: 1000,
        })
        .await;
        assert!(matches!(
            outcome,
            EmbeddingProbeOutcome::InvalidScheme { .. }
        ));
    }

    #[tokio::test]
    async fn probe_detects_empty_endpoint() {
        let outcome = probe_embedding_endpoint(EmbeddingProbeOptions {
            endpoint: "".to_string(),
            model: "text-embedding-3-small".to_string(),
            api_key: None,
            input_type: None,
            truncate: None,
            timeout_ms: 1000,
        })
        .await;
        assert!(matches!(
            outcome,
            EmbeddingProbeOutcome::InvalidScheme { .. }
        ));
    }
}
