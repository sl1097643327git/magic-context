use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use crate::pi_sessions;
use crate::project_identity::{basename, normalize_stored_project_path, resolve_project_identity};

pub fn resolve_db_path() -> Option<PathBuf> {
    // The magic-context plugin uses XDG_DATA_HOME or ~/.local/share on ALL platforms
    // (see packages/plugin/src/shared/data-path.ts). On Windows this means
    // C:\Users\<user>\.local\share — NOT %APPDATA%.
    //
    // Plugin v0.16+ stores data at the shared cortexkit path (cross-harness:
    // OpenCode + Pi share one DB). Older OpenCode-only installs lived under
    // opencode/storage/plugin/magic-context. We prefer the new location and
    // fall back to the legacy path so the dashboard keeps working when the
    // user hasn't restarted OpenCode since the upgrade.
    let data_dir = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".local")
                .join("share")
        });

    let shared_path = data_dir
        .join("cortexkit")
        .join("magic-context")
        .join("context.db");
    if shared_path.exists() {
        return Some(shared_path);
    }

    let legacy_path = data_dir
        .join("opencode")
        .join("storage")
        .join("plugin")
        .join("magic-context")
        .join("context.db");
    if legacy_path.exists() {
        Some(legacy_path)
    } else {
        None
    }
}

pub fn resolve_opencode_db_path() -> Option<PathBuf> {
    // OpenCode also uses XDG_DATA_HOME or ~/.local/share on all platforms.
    let data_dir = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".local")
                .join("share")
        });
    let db_path = data_dir.join("opencode").join("opencode.db");
    if db_path.exists() {
        Some(db_path)
    } else {
        None
    }
}

const DASHBOARD_DIR_IDENTITY_UNSAFE_SCHEMA_VERSION: i64 = 22;

pub fn dashboard_schema_warning_version(conn: &Connection) -> Result<Option<i64>, rusqlite::Error> {
    let has_migrations_table: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        [],
        |row| row.get(0),
    )?;
    if has_migrations_table == 0 {
        return Ok(None);
    }

    let version: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    Ok((version >= DASHBOARD_DIR_IDENTITY_UNSAFE_SCHEMA_VERSION).then_some(version))
}

pub fn dashboard_schema_warning_version_for_path(
    path: &PathBuf,
) -> Result<Option<i64>, rusqlite::Error> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    dashboard_schema_warning_version(&conn)
}

fn warn_if_dashboard_schema_requires_upgrade(conn: &Connection) {
    if let Ok(Some(version)) = dashboard_schema_warning_version(conn) {
        eprintln!(
            "[dashboard] Magic Context schema v{version} uses v2 dir:* identity hashing; ensure the v2 dashboard/frontend is running before trusting dir:* project reads."
        );
    }
}

/// Opens a read-only connection to the database in WAL mode.
pub fn open_readonly(path: &PathBuf) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // WAL mode is inherited from the plugin's read-write connection — no need to set it here.
    // busy_timeout is connection-local and safe on read-only connections.
    conn.pragma_update(None, "busy_timeout", 5000)?;
    warn_if_dashboard_schema_requires_upgrade(&conn);
    Ok(conn)
}

/// Opens a read-write connection for write operations (memory edits, queue entries).
pub fn open_readwrite(path: &PathBuf) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    warn_if_dashboard_schema_requires_upgrade(&conn);
    Ok(conn)
}

// ── Memory types ──────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct Memory {
    pub id: i64,
    pub project_path: String,
    pub category: String,
    pub content: String,
    pub normalized_hash: String,
    pub source_session_id: Option<String>,
    pub source_type: String,
    pub seen_count: i64,
    pub retrieval_count: i64,
    pub first_seen_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_seen_at: i64,
    pub last_retrieved_at: Option<i64>,
    pub status: String,
    pub expires_at: Option<i64>,
    pub verification_status: String,
    pub verified_at: Option<i64>,
    pub superseded_by_memory_id: Option<i64>,
    pub merged_from: Option<String>,
    pub metadata_json: Option<String>,
    pub has_embedding: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct MemoryStats {
    pub total: i64,
    pub active: i64,
    pub permanent: i64,
    pub archived: i64,
    pub with_embeddings: i64,
    pub categories: Vec<CategoryCount>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CategoryCount {
    pub category: String,
    pub count: i64,
}

// ── Session types ──────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct SessionSummary {
    pub session_id: String,
    pub title: Option<String>,
    pub project_identity: Option<String>,
    pub compartment_count: i64,
    pub fact_count: i64,
    pub note_count: i64,
    pub first_compartment_start: Option<i64>,
    pub last_compartment_end: Option<i64>,
    pub last_response_time: Option<i64>,
    pub last_context_percentage: Option<f64>,
    pub is_subagent: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Harness {
    Opencode,
    Pi,
}

impl std::str::FromStr for Harness {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "opencode" => Ok(Self::Opencode),
            "pi" => Ok(Self::Pi),
            other => Err(format!("unknown harness: {other}")),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SessionFilter {
    pub harness: Option<Harness>,
    pub project_identity: Option<String>,
    pub search: Option<String>,
    /// `Some(true)` = subagents only, `Some(false)` = primary sessions only,
    /// `None` = no filter (return both). The dashboard "Subagents" toggle
    /// sends `Some(false)` when unchecked so subagents are filtered server-side.
    pub is_subagent: Option<bool>,
    pub offset: Option<u32>,
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionRow {
    pub harness: Harness,
    pub session_id: String,
    pub title: String,
    pub project_identity: String,
    pub project_display: String,
    pub last_activity_ms: i64,
    pub is_subagent: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct PagedSessions {
    pub rows: Vec<SessionRow>,
    pub total: u32,
    pub has_more: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionMessageRow {
    pub message_id: String,
    pub timestamp_ms: i64,
    pub role: String,
    pub text_preview: String,
    pub raw_json: serde_json::Value,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionDetail {
    pub harness: Harness,
    pub session_id: String,
    pub title: String,
    pub project_identity: String,
    pub project_display: String,
    pub project_path: Option<String>,
    pub opencode_session_json: Option<serde_json::Value>,
    pub pi_jsonl_path: Option<String>,
    /// Cheap row counts so badges can render without paying the cost of the
    /// underlying lists. Messages are pulled lazily by `get_session_messages`
    /// when the user activates the Messages tab; cache events by
    /// `get_session_cache_events` for the Cache tab. Both can be tens of
    /// thousands of rows for a long-running session and dominate IPC time.
    pub messages_count: i64,
    pub cache_events_count: i64,
    pub compartments: Vec<Compartment>,
    pub facts: Vec<SessionFact>,
    pub notes: Vec<Note>,
    pub meta: Option<SessionMetaRow>,
    pub token_breakdown: Option<ContextTokenBreakdown>,
    pub pi_compaction_entries: Vec<pi_sessions::PiCompactionEntry>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProjectRow {
    pub identity: String,
    pub display_name: String,
    pub primary_path: String,
    pub harnesses: Vec<Harness>,
    pub session_count: u32,
}

#[derive(Debug, Serialize, Clone)]
pub struct Compartment {
    pub id: i64,
    pub session_id: String,
    pub sequence: i64,
    pub start_message: i64,
    pub end_message: i64,
    pub start_message_id: Option<String>,
    pub end_message_id: Option<String>,
    pub title: String,
    pub content: String,
    pub created_at: i64,
    /// Resolved from OpenCode DB using start_message_id
    pub start_time: Option<i64>,
    /// Resolved from OpenCode DB using end_message_id
    pub end_time: Option<i64>,
    /// v2 decay-rate score (1–100). Higher = decays into lower render tiers
    /// more slowly. Default 50.
    pub importance: i64,
    /// v2 episode classification — may be comma-joined (e.g. "design,bug").
    /// `None` for legacy rows.
    pub episode_type: Option<String>,
    /// v2 paraphrase tiers (P1 verbose → P4 anchor-only). `None`/empty for
    /// legacy rows that predate the tiered format.
    pub p1: Option<String>,
    pub p2: Option<String>,
    pub p3: Option<String>,
    pub p4: Option<String>,
    /// 1 = legacy pre-v2 compartment (renders degraded, no real tiers);
    /// 0 = v2 tiered compartment.
    pub legacy: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionFact {
    pub id: i64,
    pub session_id: String,
    pub category: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct Note {
    pub id: i64,
    #[serde(rename = "type")]
    pub note_type: String,
    pub status: String,
    pub content: String,
    pub session_id: Option<String>,
    pub project_path: Option<String>,
    pub surface_condition: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_checked_at: Option<i64>,
    pub ready_at: Option<i64>,
    pub ready_reason: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionMetaRow {
    pub session_id: String,
    pub last_response_time: Option<i64>,
    pub cache_ttl: Option<String>,
    pub counter: i64,
    pub last_nudge_tokens: i64,
    pub last_nudge_band: String,
    pub is_subagent: bool,
    pub last_context_percentage: f64,
    pub last_input_tokens: i64,
    pub times_execute_threshold_reached: i64,
    pub compartment_in_progress: bool,
    pub system_prompt_hash: String,
    pub memory_block_count: i64,
    pub new_work_tokens: i64,
    pub total_input_tokens: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct SubagentInvocation {
    pub id: i64,
    pub session_id: String,
    pub harness: String,
    pub subagent: String,
    pub task: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub status: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub error: Option<String>,
    pub parent_invocation_id: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SubagentTotals {
    pub subagent: String,
    pub invocations: i64,
    pub total_input: i64,
    pub total_output: i64,
    pub total_cache_read: i64,
    pub total_cache_write: i64,
}

// ── Dreamer types ──────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct DreamQueueEntry {
    pub id: i64,
    pub project_path: String,
    pub reason: String,
    pub enqueued_at: i64,
    pub started_at: Option<i64>,
    pub retry_count: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct DreamStateEntry {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct DreamRun {
    pub id: i64,
    pub project_path: String,
    pub started_at: i64,
    pub finished_at: i64,
    pub holder_id: String,
    pub tasks_json: serde_json::Value,
    pub tasks_succeeded: i64,
    pub tasks_failed: i64,
    pub smart_notes_surfaced: i64,
    pub smart_notes_pending: i64,
    pub memory_changes_json: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Clone)]
pub struct KeyFileRow {
    pub project_path: String,
    pub path: String,
    pub content: String,
    pub content_hash: String,
    pub local_token_estimate: i64,
    pub generated_at: i64,
    pub generated_by_model: Option<String>,
    pub generation_config_hash: String,
    pub stale_reason: Option<String>,
    pub version: i64,
}

// ── Note types ────────────────────────────────────────────────
// Unified Note struct replaces SessionNote and SmartNote
// Both session notes (type='session') and smart notes (type='smart') are stored in the notes table

// ── Context Token Breakdown ───────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct ContextTokenBreakdown {
    pub total_input_tokens: i64,
    pub system_prompt_tokens: i64,
    pub compartment_tokens: i64,
    pub fact_tokens: i64,
    pub memory_tokens: i64,
    pub conversation_tokens: i64, // total - compartments - facts - memories - system_prompt
    pub compartment_count: i64,
    pub fact_count: i64,
    pub memory_count: i64,
}

// ── Cache diagnostics ─────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct DbCacheEvent {
    pub harness: Harness,
    pub message_id: String,
    pub session_id: String,
    pub timestamp: i64,
    pub input_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub total_tokens: i64,
    pub hit_ratio: f64,
    pub severity: String,
    pub cause: Option<String>,
    pub agent: Option<String>,
    pub finish: Option<String>,
    pub turn_id: String,
    pub is_turn_start: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionCacheStats {
    pub harness: Harness,
    pub session_id: String,
    pub event_count: usize,
    pub total_cache_read: i64,
    pub total_cache_write: i64,
    pub total_input: i64,
    pub hit_ratio: f64,
    pub last_timestamp: String,
    pub bust_count: usize,
}

#[derive(Debug, Clone)]
struct RawDbCacheEvent {
    harness: Harness,
    message_id: String,
    session_id: String,
    timestamp: i64,
    input_tokens: i64,
    cache_read: i64,
    cache_write: i64,
    total_tokens: i64,
    agent: Option<String>,
    finish: Option<String>,
}

#[derive(Debug, Clone)]
struct LogCauseCandidate {
    session_id: String,
    timestamp: i64,
    cause: String,
}

/// Estimate tokens using ~4 chars per token (CHARS_PER_TOKEN_ESTIMATE = 4)
fn estimate_tokens(chars: i64) -> i64 {
    (chars + 3) / 4 // Round up
}

/// XML overhead for compartments (approximate: <compartment title="...">...</compartment>)
const COMPARTMENT_XML_OVERHEAD: i64 = 50;

/// Extract the `<session-history>…</session-history>` block (inclusive of the
/// tags) from a rendered m[0] snapshot. Returns `None` if the block is absent
/// (e.g. a snapshot that predates materialization). This is the real on-wire
/// decayed compartment render, used to size the Compartments token bucket.
fn extract_session_history_slice(m0_text: &str) -> Option<String> {
    const OPEN: &str = "<session-history>";
    const CLOSE: &str = "</session-history>";
    let start = m0_text.find(OPEN)?;
    let end = m0_text[start..].find(CLOSE)? + start + CLOSE.len();
    Some(m0_text[start..end].to_string())
}

pub fn get_context_token_breakdown(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<ContextTokenBreakdown>, rusqlite::Error> {
    // Get total input tokens and system prompt tokens from session_meta
    let (total_input_tokens, system_prompt_tokens): (i64, i64) = conn
        .query_row(
            "SELECT COALESCE(last_input_tokens, 0), COALESCE(system_prompt_tokens, 0) FROM session_meta WHERE session_id = ?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));

    // If no input tokens recorded, return None (no data available)
    if total_input_tokens == 0 {
        return Ok(None);
    }

    // Compartment count (for display) — always the real row count.
    let compartment_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM compartments WHERE session_id = ?1",
            [session_id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // v2: compartments are DECAY-RENDERED — most render at a lower tier
    // (p2/p3/p4) or drop past the archive boundary, so the actual injected
    // <session-history> is far smaller than Σ(full p1 content). The true
    // on-wire size is the <session-history> slice of the persisted m[0]
    // snapshot (cached_m0_bytes). Measuring Σp1 instead overcounts the
    // Compartments bucket AND starves Conversation toward 0. Mirrors the
    // plugin sidebar fix (rpc-handlers.ts).
    let m0_bytes: Option<Vec<u8>> = conn
        .query_row(
            "SELECT cached_m0_bytes FROM session_meta WHERE session_id = ?1",
            [session_id],
            |r| r.get(0),
        )
        .unwrap_or(None);
    let compartment_chars: i64 = m0_bytes
        .as_ref()
        .and_then(|b| String::from_utf8(b.clone()).ok())
        .and_then(|text| extract_session_history_slice(&text))
        .map(|slice| slice.len() as i64)
        .unwrap_or_else(|| {
            // No materialized m[0] yet (brand-new / pre-first-materialization).
            // Fall back to the Σp1 estimate so the bucket isn't blank on a cold
            // session; it self-corrects to the decayed size on first render.
            conn.query_row(
                "SELECT COALESCE(SUM(LENGTH(title) + LENGTH(content) + ?2), 0)
                 FROM compartments WHERE session_id = ?1",
                rusqlite::params![session_id, COMPARTMENT_XML_OVERHEAD],
                |r| r.get(0),
            )
            .unwrap_or(0)
        });

    // v2: facts are retired as a render source (promoted to memories), so they
    // contribute 0 render tokens. fact_count stays available for display from
    // the vestigial session_facts table, but fact_chars is 0.
    let fact_chars: i64 = 0;
    let fact_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_facts WHERE session_id = ?1",
            [session_id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // Get memory block cache (rendered XML) and count from session_meta
    let (memory_cache_str, memory_count): (Option<String>, i64) = conn
        .query_row(
            "SELECT memory_block_cache, COALESCE(memory_block_count, 0) FROM session_meta WHERE session_id = ?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((None, 0));

    let memory_chars = memory_cache_str
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(|s| s.len() as i64)
        .unwrap_or(0);

    // Estimate tokens
    let compartment_tokens = estimate_tokens(compartment_chars);
    let fact_tokens = estimate_tokens(fact_chars);
    let memory_tokens = estimate_tokens(memory_chars);

    // Conversation tokens = total - all known sections
    let known_tokens = system_prompt_tokens + compartment_tokens + fact_tokens + memory_tokens;
    let conversation_tokens = if total_input_tokens > known_tokens {
        total_input_tokens - known_tokens
    } else {
        0
    };

    Ok(Some(ContextTokenBreakdown {
        total_input_tokens,
        system_prompt_tokens,
        compartment_tokens,
        fact_tokens,
        memory_tokens,
        conversation_tokens,
        compartment_count,
        fact_count,
        memory_count,
    }))
}

// ── Database health ───────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct DbHealth {
    pub exists: bool,
    pub path: String,
    pub size_bytes: u64,
    pub wal_size_bytes: u64,
    pub table_counts: Vec<TableCount>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TableCount {
    pub table_name: String,
    pub row_count: i64,
}

// ── Helpers ───────────────────────────────────────────────────

/// Compute a normalized hash matching the plugin's dedup logic:
/// lowercase → trim whitespace → hash as hex string.
/// Uses std::hash for portability (no SHA crate in deps); the exact
/// hash algorithm doesn't matter as long as it's consistent within
/// the dashboard. The plugin uses its own Bun-based hash path.
/// Match the plugin's `computeNormalizedHash`: lowercase → collapse whitespace → trim → MD5 hex.
fn normalize_hash(content: &str) -> String {
    let normalized = content.to_lowercase();
    // Collapse all whitespace runs into a single space (mirrors JS /\s+/g → " ")
    let normalized: String = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    let digest = md5::compute(normalized.as_bytes());
    format!("{:032x}", digest)
}

fn format_timestamp_iso(timestamp: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| timestamp.to_string())
}

fn parse_log_timestamp_millis(timestamp: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .map(|dt| dt.timestamp_millis())
        .ok()
}

fn detect_log_cache_cause(
    entries: &[crate::log_parser::LogEntry],
    event_idx: usize,
) -> Option<String> {
    let event = &entries[event_idx];
    let window_start = event_idx.saturating_sub(10);
    let window_end = std::cmp::min(event_idx + 4, entries.len());
    let mut causes = Vec::new();

    for entry in &entries[window_start..window_end] {
        if entry.session_id != event.session_id {
            continue;
        }

        let msg = &entry.message;
        if msg.contains("Execute pass") || (msg.contains("applied") && msg.contains("ops")) {
            causes.push("Execute pass".to_string());
        }
        if msg.contains("compartments") && msg.contains("→") {
            causes.push("Historian output".to_string());
        }
        if msg.contains("variant change") || msg.contains("Variant change") {
            causes.push("Variant change".to_string());
        }
        if msg.contains("system prompt hash") {
            causes.push("System prompt hash change".to_string());
        }
        if msg.contains("heuristic cleanup") || msg.contains("tool tags dropped") {
            causes.push("Heuristic cleanup".to_string());
        }
    }

    causes.dedup();
    if causes.is_empty() {
        None
    } else {
        Some(causes.join(", "))
    }
}

fn build_log_cause_candidates() -> Vec<LogCauseCandidate> {
    let log_path = crate::log_parser::resolve_log_path();
    let entries = crate::log_parser::read_log_tail(&log_path, 5000);

    entries
        .iter()
        .enumerate()
        .filter_map(|(idx, entry)| {
            if entry.session_id.is_empty()
                || entry.cache_read.is_none()
                || entry.cache_write.is_none()
            {
                return None;
            }

            let timestamp = parse_log_timestamp_millis(&entry.timestamp)?;
            let cause = detect_log_cache_cause(&entries, idx)?;

            Some(LogCauseCandidate {
                session_id: entry.session_id.clone(),
                timestamp,
                cause,
            })
        })
        .collect()
}

fn match_log_cause(
    candidates: &[LogCauseCandidate],
    session_id: &str,
    timestamp: i64,
) -> Option<String> {
    let mut matches: Vec<(i64, &str)> = candidates
        .iter()
        .filter(|candidate| candidate.session_id == session_id)
        .filter_map(|candidate| {
            let distance = (candidate.timestamp - timestamp).abs();
            if distance <= 5_000 {
                Some((distance, candidate.cause.as_str()))
            } else {
                None
            }
        })
        .collect();

    matches.sort_by_key(|(distance, _)| *distance);

    let mut deduped = Vec::new();
    for (_, cause) in matches {
        if !deduped.iter().any(|existing: &String| existing == cause) {
            deduped.push(cause.to_string());
        }
    }

    if deduped.is_empty() {
        None
    } else {
        Some(deduped.join(", "))
    }
}

fn load_raw_db_cache_events(
    limit: usize,
    since_timestamp: Option<i64>,
) -> Result<Vec<RawDbCacheEvent>, rusqlite::Error> {
    let Some(opencode_db_path) = resolve_opencode_db_path() else {
        return Ok(Vec::new());
    };

    let conn = open_readonly(&opencode_db_path)?;

    // Per-session windowing: each session gets up to `limit` recent events
    // (so a session-filtered timeline always has full bar coverage), capped
    // globally at `limit * 10` to bound memory across many concurrent sessions.
    // Without this, a 200-event global window split across e.g. 4 active
    // sessions left each session with only ~50 bars on the chart.
    let per_session_limit = limit as i64;
    let global_cap = per_session_limit.saturating_mul(10);

    let (sql, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = if let Some(since) =
        since_timestamp
    {
        (
            "WITH ranked AS (
                SELECT CAST(m.id AS TEXT) AS msg_id,
                       m.session_id,
                       m.time_created,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.input') AS INTEGER), 0) AS input_tokens,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.cache.read') AS INTEGER), 0) AS cache_read,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.cache.write') AS INTEGER), 0) AS cache_write,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.total') AS INTEGER), 0) AS total_tokens,
                       CAST(json_extract(m.data, '$.agent') AS TEXT) AS agent,
                       CAST(json_extract(m.data, '$.finish') AS TEXT) AS finish,
                       ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_created DESC) AS rn
                FROM message m
                WHERE json_extract(m.data, '$.role') = 'assistant'
                  AND COALESCE(CAST(json_extract(m.data, '$.tokens.total') AS INTEGER), 0) > 0
                  AND m.time_created > ?1
            )
            SELECT msg_id, session_id, time_created, input_tokens, cache_read,
                   cache_write, total_tokens, agent, finish
            FROM ranked
            WHERE rn <= ?2
            ORDER BY time_created DESC
            LIMIT ?3".to_string(),
            vec![
                Box::new(since) as Box<dyn rusqlite::types::ToSql>,
                Box::new(per_session_limit),
                Box::new(global_cap),
            ],
        )
    } else {
        (
            "WITH ranked AS (
                SELECT CAST(m.id AS TEXT) AS msg_id,
                       m.session_id,
                       m.time_created,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.input') AS INTEGER), 0) AS input_tokens,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.cache.read') AS INTEGER), 0) AS cache_read,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.cache.write') AS INTEGER), 0) AS cache_write,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.total') AS INTEGER), 0) AS total_tokens,
                       CAST(json_extract(m.data, '$.agent') AS TEXT) AS agent,
                       CAST(json_extract(m.data, '$.finish') AS TEXT) AS finish,
                       ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_created DESC) AS rn
                FROM message m
                WHERE json_extract(m.data, '$.role') = 'assistant'
                  AND COALESCE(CAST(json_extract(m.data, '$.tokens.total') AS INTEGER), 0) > 0
            )
            SELECT msg_id, session_id, time_created, input_tokens, cache_read,
                   cache_write, total_tokens, agent, finish
            FROM ranked
            WHERE rn <= ?1
            ORDER BY time_created DESC
            LIMIT ?2".to_string(),
            vec![
                Box::new(per_session_limit) as Box<dyn rusqlite::types::ToSql>,
                Box::new(global_cap),
            ],
        )
    };

    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(RawDbCacheEvent {
            harness: Harness::Opencode,
            message_id: row.get(0)?,
            session_id: row.get(1)?,
            timestamp: row.get(2)?,
            input_tokens: row.get(3)?,
            cache_read: row.get(4)?,
            cache_write: row.get(5)?,
            total_tokens: row.get(6)?,
            agent: row.get(7)?,
            finish: row.get(8)?,
        })
    })?;

    rows.collect()
}

/// Load Pi cache events from JSONL session files. Mirrors the per-session
/// windowing the OpenCode SQL path does so a single noisy Pi session cannot
/// monopolize the global view, and emits the same `RawDbCacheEvent` shape as
/// OpenCode so downstream `build_db_cache_events` works unchanged.
fn load_raw_pi_cache_events(limit: usize, since_timestamp: Option<i64>) -> Vec<RawDbCacheEvent> {
    let per_session_limit = limit;
    let global_cap = limit.saturating_mul(10);
    let mut all_rows: Vec<RawDbCacheEvent> = Vec::new();

    for meta in pi_sessions::scan_pi_session_dir() {
        let Some(detail) = pi_sessions::read_pi_session_detail(&meta.jsonl_path) else {
            continue;
        };
        // Pi message timestamps are ms-since-epoch; the OpenCode side uses ms too,
        // so we keep them in the same unit and on the same time axis.
        let mut session_rows: Vec<RawDbCacheEvent> = detail
            .messages
            .iter()
            .filter(|message| message.role == "assistant")
            .filter_map(|message| {
                let usage = message.usage.as_ref()?;
                if usage.total == 0 {
                    return None;
                }
                if let Some(since) = since_timestamp {
                    if message.timestamp_ms <= since {
                        return None;
                    }
                }
                Some(RawDbCacheEvent {
                    harness: Harness::Pi,
                    message_id: message.entry_id.clone(),
                    session_id: meta.session_id.clone(),
                    timestamp: message.timestamp_ms,
                    input_tokens: usage.input as i64,
                    cache_read: usage.cache_read as i64,
                    cache_write: usage.cache_write as i64,
                    total_tokens: usage.total as i64,
                    agent: None,
                    finish: message.stop_reason.clone(),
                })
            })
            .collect();
        // Per-session newest-first window so a long Pi session still surfaces
        // its latest events on the merged timeline.
        session_rows.sort_by_key(|r| std::cmp::Reverse(r.timestamp));
        session_rows.truncate(per_session_limit);
        all_rows.extend(session_rows);
    }

    all_rows.sort_by_key(|r| std::cmp::Reverse(r.timestamp));
    all_rows.truncate(global_cap);
    all_rows
}

fn build_db_cache_events(rows: Vec<RawDbCacheEvent>, enrich_causes: bool) -> Vec<DbCacheEvent> {
    let log_cause_candidates = if enrich_causes {
        build_log_cause_candidates()
    } else {
        Vec::new()
    };

    // Build a map of earliest timestamp per session in our window so we can
    // detect whether an event is truly the session's first message vs just
    // the oldest event in the current 200-event window. Keyed by
    // (harness, session_id) because OC and Pi may share short ID prefixes
    // and must never alias each other in this analysis.
    let mut earliest_ts_in_window: HashMap<(Harness, String), i64> = HashMap::new();
    for row in &rows {
        earliest_ts_in_window
            .entry((row.harness, row.session_id.clone()))
            .and_modify(|ts| {
                if row.timestamp < *ts {
                    *ts = row.timestamp;
                }
            })
            .or_insert(row.timestamp);
    }

    // OC-side: check which sessions truly have their first-ever assistant
    // message in our window by computing each session's true-first assistant
    // message timestamp in a single GROUP BY query, then comparing to our
    // window's earliest. Pi sessions are excluded here because Pi cache rows
    // come from JSONL files, not OpenCode's `message` table — Pi
    // first-message detection is handled in `pi_true_first_sessions` below.
    let oc_session_ids: Vec<String> = earliest_ts_in_window
        .iter()
        .filter(|((h, _), _)| matches!(h, Harness::Opencode))
        .map(|((_, sid), _)| sid.clone())
        .collect();
    let true_first_sessions: HashSet<(Harness, String)> = if !oc_session_ids.is_empty() {
        if let Some(opencode_db_path) = resolve_opencode_db_path() {
            if let Ok(conn) = open_readonly(&opencode_db_path) {
                // Build IN-clause with placeholders for each session_id we care about.
                let placeholders = vec!["?"; oc_session_ids.len()].join(",");
                let sql = format!(
                        "SELECT session_id, MIN(time_created) AS first_ts
                         FROM message
                         WHERE session_id IN ({})
                           AND json_extract(data, '$.role') = 'assistant'
                           AND COALESCE(CAST(json_extract(data, '$.tokens.total') AS INTEGER), 0) > 0
                         GROUP BY session_id",
                        placeholders
                    );
                let session_id_refs: Vec<&dyn rusqlite::types::ToSql> = oc_session_ids
                    .iter()
                    .map(|s| s as &dyn rusqlite::types::ToSql)
                    .collect();
                if let Ok(mut stmt) = conn.prepare(&sql) {
                    let rows = stmt.query_map(session_id_refs.as_slice(), |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    });
                    if let Ok(rows) = rows {
                        // A session is "truly first" in our window if its
                        // window-earliest timestamp matches its DB-wide
                        // earliest assistant timestamp.
                        rows.filter_map(|r| r.ok())
                            .filter(|(sid, db_earliest)| {
                                earliest_ts_in_window
                                    .get(&(Harness::Opencode, sid.clone()))
                                    .map(|window_earliest| *window_earliest <= *db_earliest)
                                    .unwrap_or(false)
                            })
                            .map(|(sid, _)| (Harness::Opencode, sid))
                            .collect()
                    } else {
                        HashSet::new()
                    }
                } else {
                    HashSet::new()
                }
            } else {
                HashSet::new()
            }
        } else {
            HashSet::new()
        }
    } else {
        HashSet::new()
    };

    // Pi-side: a Pi session has its true-first assistant message in our window
    // when our window-earliest timestamp for that Pi session is also the
    // earliest assistant timestamp in the underlying JSONL file. Read each Pi
    // session's first assistant timestamp once and compare.
    let mut pi_true_first: HashSet<(Harness, String)> = HashSet::new();
    let pi_sessions_in_window: Vec<String> = earliest_ts_in_window
        .iter()
        .filter(|((h, _), _)| matches!(h, Harness::Pi))
        .map(|((_, sid), _)| sid.clone())
        .collect();
    if !pi_sessions_in_window.is_empty() {
        // Build a lookup of Pi session_id -> jsonl path so we don't re-scan
        // the directory per session.
        let pi_meta_by_id: HashMap<String, std::path::PathBuf> = pi_sessions::scan_pi_session_dir()
            .into_iter()
            .map(|m| (m.session_id, m.jsonl_path))
            .collect();
        for sid in pi_sessions_in_window {
            let Some(path) = pi_meta_by_id.get(&sid) else {
                continue;
            };
            let Some(detail) = pi_sessions::read_pi_session_detail(path) else {
                continue;
            };
            let db_earliest = detail
                .messages
                .iter()
                .filter(|m| {
                    m.role == "assistant" && m.usage.as_ref().map(|u| u.total > 0).unwrap_or(false)
                })
                .map(|m| m.timestamp_ms)
                .min();
            if let (Some(db_earliest), Some(window_earliest)) = (
                db_earliest,
                earliest_ts_in_window.get(&(Harness::Pi, sid.clone())),
            ) {
                if *window_earliest <= db_earliest {
                    pi_true_first.insert((Harness::Pi, sid));
                }
            }
        }
    }
    let true_first_sessions: HashSet<(Harness, String)> = true_first_sessions
        .into_iter()
        .chain(pi_true_first)
        .collect();

    let mut seen_sessions: HashSet<(Harness, String)> = HashSet::new();
    let mut chronological = Vec::with_capacity(rows.len());

    for row in rows.into_iter().rev() {
        let total_prompt = row.input_tokens + row.cache_read + row.cache_write;
        let hit_ratio = if total_prompt > 0 {
            row.cache_read as f64 / total_prompt as f64
        } else {
            0.0
        };

        let session_key = (row.harness, row.session_id.clone());
        let is_first_session_event = seen_sessions.insert(session_key.clone());
        let is_truly_first = is_first_session_event && true_first_sessions.contains(&session_key);
        let (severity, cause) = if is_truly_first {
            (
                "info".to_string(),
                Some("First message (new session)".to_string()),
            )
        } else if row.cache_read == 0 && row.cache_write > 0 {
            (
                "full_bust".to_string(),
                match_log_cause(&log_cause_candidates, &row.session_id, row.timestamp),
            )
        } else if hit_ratio < 0.5 {
            (
                "bust".to_string(),
                match_log_cause(&log_cause_candidates, &row.session_id, row.timestamp),
            )
        } else if hit_ratio < 0.9 {
            (
                "warning".to_string(),
                if enrich_causes {
                    match_log_cause(&log_cause_candidates, &row.session_id, row.timestamp)
                } else {
                    None
                },
            )
        } else {
            ("stable".to_string(), None)
        };

        chronological.push(DbCacheEvent {
            harness: row.harness,
            message_id: row.message_id,
            session_id: row.session_id,
            timestamp: row.timestamp,
            input_tokens: row.input_tokens,
            cache_read: row.cache_read,
            cache_write: row.cache_write,
            total_tokens: row.total_tokens,
            hit_ratio,
            severity,
            cause,
            agent: row.agent,
            finish: row.finish,
            turn_id: String::new(),
            is_turn_start: false,
        });
    }

    // ── Turn grouping & warming severity ────────────────────────────
    // Walk chronological events per session. A new turn starts when:
    //   - this is the first event for the session, OR
    //   - the PREVIOUS event in the same session had finish != "tool-calls"
    // Continuation events that show cache_read < 90% of expected
    // (previous.cache_read + previous.cache_write) are downgraded to "warming".
    //
    // Inputs to this function may arrive in any order; the severity-loop above
    // happens to consume rows newest→oldest via .rev(), producing a vec that
    // is NOT guaranteed chronological. Sort ascending by timestamp here so
    // "previous" really means "earlier in time" before computing turn IDs.
    chronological.sort_by_key(|e| e.timestamp);

    let mut last_finish_by_session: HashMap<(Harness, String), String> = HashMap::new();
    let mut current_turn_id_by_session: HashMap<(Harness, String), String> = HashMap::new();
    let mut prev_event_idx_by_session: HashMap<(Harness, String), usize> = HashMap::new();

    for i in 0..chronological.len() {
        let session_key = (
            chronological[i].harness,
            chronological[i].session_id.clone(),
        );
        let prev_finish = last_finish_by_session.get(&session_key).cloned();
        let is_new_turn = match prev_finish.as_deref() {
            None => true,
            Some("tool-calls") => false,
            Some(_) => true,
        };

        chronological[i].is_turn_start = is_new_turn;
        if is_new_turn {
            chronological[i].turn_id = chronological[i].message_id.clone();
            current_turn_id_by_session
                .insert(session_key.clone(), chronological[i].message_id.clone());
        } else {
            chronological[i].turn_id = current_turn_id_by_session
                .get(&session_key)
                .cloned()
                .unwrap_or_default();
        }

        // Warming check for continuation events
        if !is_new_turn {
            if let Some(&prev_idx) = prev_event_idx_by_session.get(&session_key) {
                let prev = &chronological[prev_idx];
                let expected = prev.cache_read + prev.cache_write;
                if expected > 0
                    && chronological[i].cache_read < (expected as f64 * 0.9) as i64
                    && (chronological[i].severity == "warning"
                        || chronological[i].severity == "bust")
                {
                    chronological[i].severity = "warming".to_string();
                }
            }
        }

        prev_event_idx_by_session.insert(session_key.clone(), i);
        last_finish_by_session.insert(
            session_key,
            chronological[i].finish.clone().unwrap_or_default(),
        );
    }

    chronological
}

pub fn get_cache_events_from_db(limit: usize, since_timestamp: Option<i64>) -> Vec<DbCacheEvent> {
    let mut rows = load_raw_db_cache_events(limit, since_timestamp).unwrap_or_default();
    rows.extend(load_raw_pi_cache_events(limit, since_timestamp));
    // Newest-first across both harnesses, then truncate to the same global cap
    // the OpenCode-only path used so the merged feed never balloons unbounded.
    rows.sort_by_key(|r| std::cmp::Reverse(r.timestamp));
    rows.truncate(limit.saturating_mul(10));
    build_db_cache_events(rows, true)
}

type SessionCacheStatsAccumulator = (usize, i64, i64, i64, i64, usize);

pub fn get_session_cache_stats_from_db(limit: usize) -> Vec<SessionCacheStats> {
    // Reuse raw rows instead of re-querying + re-parsing logs
    let mut rows = load_raw_db_cache_events(200, None).unwrap_or_default();
    rows.extend(load_raw_pi_cache_events(200, None));
    rows.sort_by_key(|r| std::cmp::Reverse(r.timestamp));
    rows.truncate(2000); // 200 per-session × ~10 sessions cap
    let events = build_db_cache_events(rows, false); // skip log enrichment for stats
                                                     // Key by (harness, session_id) so OC and Pi sessions never collide on a
                                                     // shared short-prefix session ID.
    let mut map: HashMap<(Harness, String), SessionCacheStatsAccumulator> = HashMap::new();

    for event in events {
        if event.session_id.is_empty() {
            continue;
        }

        let entry = map
            .entry((event.harness, event.session_id.clone()))
            .or_insert((0, 0, 0, 0, event.timestamp, 0));
        entry.0 += 1;
        entry.1 += event.cache_read;
        entry.2 += event.cache_write;
        entry.3 += event.input_tokens;
        entry.4 = entry.4.max(event.timestamp);
        if event.severity == "bust" || event.severity == "full_bust" {
            entry.5 += 1;
        }
    }

    let mut stats: Vec<(i64, SessionCacheStats)> = map
        .into_iter()
        .map(
            |(
                (harness, session_id),
                (
                    event_count,
                    total_cache_read,
                    total_cache_write,
                    total_input,
                    last_timestamp,
                    bust_count,
                ),
            )| {
                let total_prompt = total_cache_read + total_cache_write + total_input;
                let hit_ratio = if total_prompt > 0 {
                    total_cache_read as f64 / total_prompt as f64
                } else {
                    0.0
                };

                (
                    last_timestamp,
                    SessionCacheStats {
                        harness,
                        session_id,
                        event_count,
                        total_cache_read,
                        total_cache_write,
                        total_input,
                        hit_ratio,
                        last_timestamp: format_timestamp_iso(last_timestamp),
                        bust_count,
                    },
                )
            },
        )
        .collect();

    stats.sort_by_key(|(timestamp, _)| std::cmp::Reverse(*timestamp));
    stats.truncate(limit);
    stats.into_iter().map(|(_, stat)| stat).collect()
}

// `limit` caps the returned event count to the most recent N (newest-first
// selection from the DB, then re-sorted to chronological for the chart).
// Passing 0 or a huge value effectively returns the whole session — keep
// the dashboard's PER_SESSION = 200 budget in mind on call sites that go
// straight into a chart, because every event is ~250 bytes of JSON across
// the Tauri IPC boundary and a hot session can produce 30k+ events.
pub fn get_session_cache_events(
    harness: Harness,
    session_id: &str,
    limit: Option<usize>,
) -> Vec<DbCacheEvent> {
    match harness {
        Harness::Opencode => get_opencode_session_cache_events(session_id, limit),
        Harness::Pi => get_pi_session_cache_events(session_id, limit),
    }
}

/// Trim a chronologically-ordered event list to at most `target_turns`
/// complete turns, keeping the most recent turns.
fn trim_events_to_turns(events: Vec<DbCacheEvent>, target_turns: usize) -> Vec<DbCacheEvent> {
    if events.is_empty() || target_turns == 0 {
        return Vec::new();
    }
    let turn_starts: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, e)| e.is_turn_start)
        .map(|(i, _)| i)
        .collect();
    if turn_starts.len() <= target_turns {
        return events;
    }
    let keep_from_idx = turn_starts[turn_starts.len() - target_turns];
    events.into_iter().skip(keep_from_idx).collect()
}

/// Fetch events for one session, trimmed so the result contains at most
/// `target_turns` complete turns (most recent first). Events are returned
/// in chronological order (oldest → newest).
///
/// Strategy: fetch up to `max_events = target_turns * 50` raw events (cap of 50
/// events/turn is conservative — even very heavy tool-use turns rarely exceed
/// that). Then group into turns. If we got more than target_turns, drop oldest
/// events until only `target_turns` most-recent turns remain.
pub fn get_session_cache_events_by_turn_count(
    harness: Harness,
    session_id: &str,
    target_turns: usize,
) -> Vec<DbCacheEvent> {
    let max_events = (target_turns * 50).max(200); // floor to existing limit
    let raw = match harness {
        Harness::Opencode => get_opencode_session_cache_events(session_id, Some(max_events)),
        Harness::Pi => get_pi_session_cache_events(session_id, Some(max_events)),
    };
    trim_events_to_turns(raw, target_turns)
}

fn get_opencode_session_cache_events(session_id: &str, limit: Option<usize>) -> Vec<DbCacheEvent> {
    let Some(opencode_db_path) = resolve_opencode_db_path() else {
        return Vec::new();
    };
    let Ok(conn) = open_readonly(&opencode_db_path) else {
        return Vec::new();
    };

    // Bound `limit` to something sane. The SQL window is small enough that
    // rusqlite can bind it as i64 directly; we then reverse to chronological
    // in build_db_cache_events / by sort below.
    let lim: i64 = match limit {
        Some(n) if n > 0 => n as i64,
        // None == no cap; SQLite treats negative LIMIT as "no limit".
        _ => -1,
    };

    let Ok(mut stmt) = conn.prepare(
        "SELECT CAST(id AS TEXT), session_id, time_created,
                COALESCE(CAST(json_extract(data, '$.tokens.input') AS INTEGER), 0),
                COALESCE(CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER), 0),
                COALESCE(CAST(json_extract(data, '$.tokens.cache.write') AS INTEGER), 0),
                COALESCE(CAST(json_extract(data, '$.tokens.total') AS INTEGER), 0),
                CAST(json_extract(data, '$.agent') AS TEXT),
                CAST(json_extract(data, '$.finish') AS TEXT)
         FROM message
         WHERE session_id = ?1
           AND json_extract(data, '$.role') = 'assistant'
           AND COALESCE(CAST(json_extract(data, '$.tokens.total') AS INTEGER), 0) > 0
         ORDER BY time_created DESC
         LIMIT ?2",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(rusqlite::params![session_id, lim], |row| {
        Ok(RawDbCacheEvent {
            harness: Harness::Opencode,
            message_id: row.get(0)?,
            session_id: row.get(1)?,
            timestamp: row.get(2)?,
            input_tokens: row.get(3)?,
            cache_read: row.get(4)?,
            cache_write: row.get(5)?,
            total_tokens: row.get(6)?,
            agent: row.get(7)?,
            finish: row.get(8)?,
        })
    }) else {
        return Vec::new();
    };
    // build_db_cache_events sorts by timestamp ASC, so DESC LIMIT then ASC
    // sort yields the most-recent N in chronological order.
    build_db_cache_events(rows.flatten().collect(), true)
}

fn get_pi_session_cache_events(session_id: &str, limit: Option<usize>) -> Vec<DbCacheEvent> {
    let Some(path) = pi_sessions::find_pi_session_path(session_id) else {
        return Vec::new();
    };
    let Some(detail) = pi_sessions::read_pi_session_detail(&path) else {
        return Vec::new();
    };
    let mut rows: Vec<RawDbCacheEvent> = detail
        .messages
        .into_iter()
        .filter(|message| message.role == "assistant")
        .filter_map(|message| {
            let usage = message.usage?;
            (usage.total > 0).then_some(RawDbCacheEvent {
                harness: Harness::Pi,
                message_id: message.entry_id,
                session_id: session_id.to_string(),
                timestamp: message.timestamp_ms,
                input_tokens: usage.input as i64,
                cache_read: usage.cache_read as i64,
                cache_write: usage.cache_write as i64,
                total_tokens: usage.total as i64,
                agent: None,
                finish: message.stop_reason,
            })
        })
        .collect();
    // Tail-truncate to the most-recent N entries (Pi JSONL is naturally
    // chronological, so the last N are the freshest).
    if let Some(n) = limit {
        if n > 0 && rows.len() > n {
            let start = rows.len() - n;
            rows.drain(..start);
        }
    }
    build_db_cache_events(rows, false)
}

// ── Project resolution ────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct ProjectInfo {
    pub identity: String,
    pub label: String,        // friendly name (directory basename or identity)
    pub path: Option<String>, // resolved filesystem path, if found
}

pub fn get_projects(conn: &Connection) -> Result<Vec<ProjectInfo>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT project_path FROM memories
         UNION
         SELECT project_path FROM dream_queue
         UNION
         SELECT project_path FROM dream_runs
         ORDER BY project_path",
    )?;
    let stored_values: Vec<String> = stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut identities: Vec<String> = stored_values
        .into_iter()
        .map(|value| normalize_stored_project_path(&value))
        .filter(|identity| !identity.is_empty())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    identities.sort();

    // Resolve friendly names/paths via the same enumeration the project picker
    // uses. enumerate_projects_filtered recomputes identity with
    // resolve_project_identity(&worktree) — the SAME git root-commit space the
    // plugin stamps into git:<sha> — so these identities match. The older
    // resolve_from_opencode_db matched git:<sha> against OpenCode's project.id,
    // which is a DIFFERENT hash, so it never resolved a name and every Dreamer
    // row fell back to git:<short>… (the regression this fixes).
    let identity_to_row: HashMap<String, ProjectRow> = enumerate_projects_filtered(None)
        .into_iter()
        .map(|row| (row.identity.clone(), row))
        .collect();

    let projects = identities
        .into_iter()
        .map(|id| {
            let (label, path) = if let Some(row) = identity_to_row.get(&id) {
                (row.display_name.clone(), Some(row.primary_path.clone()))
            } else if id.starts_with("git:") {
                let short = &id[4..std::cmp::min(id.len(), 14)];
                (format!("git:{short}…"), None)
            } else {
                (id.clone(), None)
            };
            ProjectInfo {
                identity: id,
                label,
                path,
            }
        })
        .collect();

    Ok(projects)
}

pub fn enumerate_projects() -> Vec<ProjectRow> {
    enumerate_projects_filtered(None)
}

pub fn enumerate_memory_projects(conn: &Connection) -> Result<Vec<ProjectRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT project_path
         FROM memories
         WHERE status = 'active'
         ORDER BY project_path",
    )?;
    let memory_project_values: HashSet<String> = stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<HashSet<_>, _>>()?;

    // Each memory `project_path` is canonically one of:
    //   - a resolved project identity (`git:<hash>` or `dir:<md5-12>`) for
    //     memories written by the post-#87 plugin where storage stamps the
    //     identity directly, or
    //   - a raw filesystem path for legacy memories written before identity
    //     normalization landed on the plugin side.
    //
    // Normalize every value to its identity. For identity-shaped strings the
    // value is itself the identity. For real paths we resolve through git +
    // MD5-12 fallback. This is the SAME normalization the v0.21.5 plugin-side
    // fix to issue #87 performs on the query side — keeping the dashboard
    // aligned with it so the project picker matches the memory pool by
    // identity, not by raw path.
    let memory_identities: HashSet<String> = memory_project_values
        .iter()
        .map(|value| normalize_stored_project_path(value))
        .collect();

    // Build the full project list from OpenCode + Pi DBs (which gives us the
    // real `display_name` and `primary_path` for each project), then filter
    // down to projects whose identity has at least one memory in the pool.
    let all = enumerate_projects_filtered(None);
    Ok(all
        .into_iter()
        .filter(|row| memory_identities.contains(&row.identity))
        .collect())
}

fn enumerate_projects_filtered(project_paths_filter: Option<&HashSet<String>>) -> Vec<ProjectRow> {
    #[derive(Default)]
    struct ProjectAccum {
        opencode_name: Option<String>,
        opencode_path: Option<String>,
        pi_path: Option<String>,
        harnesses: HashSet<Harness>,
        session_count: u32,
    }

    let mut groups: HashMap<String, ProjectAccum> = HashMap::new();

    if let Some(opencode_db_path) = resolve_opencode_db_path() {
        if let Ok(conn) = open_readonly(&opencode_db_path) {
            if let Ok(mut stmt) = conn.prepare(
                "SELECT p.name, p.worktree, COUNT(s.id)
                 FROM project p LEFT JOIN session s ON s.project_id = p.id
                 GROUP BY p.id, p.name, p.worktree",
            ) {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                }) {
                    for (name, worktree, count) in rows.flatten() {
                        if let Some(allowed_paths) = project_paths_filter {
                            if !allowed_paths.contains(&worktree) {
                                continue;
                            }
                        }
                        let identity = resolve_project_identity(&worktree);
                        let entry = groups.entry(identity).or_default();
                        if !name.is_empty() {
                            entry.opencode_name = Some(name);
                        }
                        entry.opencode_path = Some(worktree);
                        entry.harnesses.insert(Harness::Opencode);
                        entry.session_count =
                            entry.session_count.saturating_add(count.max(0) as u32);
                    }
                }
            }
        }
    }

    let mut pi_counts: HashMap<String, (String, u32)> = HashMap::new();
    for meta in pi_sessions::scan_pi_session_dir() {
        if let Some(allowed_paths) = project_paths_filter {
            if !allowed_paths.contains(&meta.cwd) {
                continue;
            }
        }
        let identity = resolve_project_identity(&meta.cwd);
        let entry = pi_counts.entry(identity).or_insert((meta.cwd, 0));
        entry.1 = entry.1.saturating_add(1);
    }
    if let Some(allowed_paths) = project_paths_filter {
        for project_path in allowed_paths {
            let identity = resolve_project_identity(project_path);
            groups.entry(identity).or_insert_with(|| ProjectAccum {
                opencode_path: Some(project_path.clone()),
                ..ProjectAccum::default()
            });
        }
    }

    for (identity, (cwd, count)) in pi_counts {
        let entry = groups.entry(identity).or_default();
        entry.pi_path = Some(cwd);
        entry.harnesses.insert(Harness::Pi);
        entry.session_count = entry.session_count.saturating_add(count);
    }

    let mut rows: Vec<ProjectRow> = groups
        .into_iter()
        .map(|(identity, group)| {
            let primary_path = group
                .opencode_path
                .clone()
                .or(group.pi_path.clone())
                .unwrap_or_default();
            let display_name = group
                .opencode_name
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| basename(&primary_path));
            let mut harnesses: Vec<Harness> = group.harnesses.into_iter().collect();
            harnesses.sort();
            ProjectRow {
                identity,
                display_name,
                primary_path,
                harnesses,
                session_count: group.session_count,
            }
        })
        .collect();
    rows.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    rows
}

// ── Query implementations ─────────────────────────────────────

/// Resolve a project filter value (an identity like `git:<hash>` / `dir:<sha>`,
/// or a legacy raw filesystem path) into the set of `memories.project_path`
/// values that should be matched against.
///
/// **Why this exists**: the dashboard frontend sends the resolved project
/// identity as the filter (matches how History does it), but the `memories`
/// table stores raw filesystem paths in `project_path` — `git:<hash>` would
/// never equal `/Users/.../my-repo`. We map the identity to every concrete
/// path that resolves to it.
///
/// **Why this matters for clones/worktrees**: the same git repo cloned to two
/// directories (or checked out as multiple worktrees) shares one root-commit
/// identity but contributes memories under different `project_path` values.
/// Sending just `primary_path` from the frontend would silently miss memories
/// written from other clones. This helper returns ALL contributing paths so
/// the union is queried.
///
/// **Backward compatibility**: if the filter value is a legacy raw path
/// (older dashboard build, or external caller), no rows resolve to it as an
/// identity and we fall back to filtering by that single value — same
/// behavior as the pre-fix code.
fn resolve_paths_for_memory_filter(
    conn: &Connection,
    project_filter: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    // Pull every distinct stored memory project_path. The set is small (one
    // per project that ever wrote memories), so the cost is bounded by the
    // number of distinct projects, not memories.
    let mut stmt = conn.prepare("SELECT DISTINCT project_path FROM memories")?;
    let all_paths: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    // Resolve each stored path to an identity and keep the ones that match
    // the requested filter. `resolve_project_identity` caches results so
    // repeated calls are cheap.
    let normalized_filter = normalize_stored_project_path(project_filter);
    let mut matched: Vec<String> = all_paths
        .into_iter()
        .filter(|path| normalize_stored_project_path(path) == normalized_filter)
        .collect();

    if matched.is_empty() {
        // No stored path resolves to this identity. Treat the incoming value
        // as a legacy raw path filter for backward compatibility — same as
        // pre-fix behavior, which only worked when frontend sent raw paths.
        matched.push(project_filter.to_string());
    }
    Ok(matched)
}

/// Build a SQL `IN (?, ?, ...)` placeholder string starting at parameter
/// index `start_idx` (1-based). Returns the placeholder string. Caller is
/// responsible for pushing the actual values onto the params vec in the same
/// order.
fn build_in_placeholders(count: usize, start_idx: usize) -> String {
    (0..count)
        .map(|i| format!("?{}", start_idx + i))
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn get_memories(
    conn: &Connection,
    project_filter: Option<&str>,
    status_filter: Option<&str>,
    category_filter: Option<&str>,
    search_query: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<Memory>, rusqlite::Error> {
    let raw_search = search_query.unwrap_or("").trim().to_string();
    let has_search = !raw_search.is_empty();

    // Sanitize search query for FTS5: wrap each token in double quotes so
    // special characters (/, -, etc.) are treated as literals, matching the
    // plugin's sanitizeFtsQuery() approach.
    let sanitized_fts = if has_search {
        let tokens: Vec<String> = raw_search
            .split_whitespace()
            .filter(|t| !t.is_empty())
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect();
        if tokens.is_empty() {
            String::new()
        } else {
            tokens.join(" ")
        }
    } else {
        String::new()
    };
    let use_fts = !sanitized_fts.is_empty();
    // For very short queries (< 3 chars) or if FTS sanitization produces nothing,
    // fall back to LIKE which handles partial matches better
    let use_like_fallback = has_search && (!use_fts || raw_search.len() < 3);
    let like_pattern = format!("%{}%", raw_search.replace('%', "\\%").replace('_', "\\_"));

    // Build WHERE clauses and params dynamically
    let mut conditions = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if use_fts && !use_like_fallback {
        params.push(Box::new(sanitized_fts.clone()));
        // FTS match uses the first param
    } else if has_search {
        params.push(Box::new(like_pattern.clone()));
        // LIKE uses the first param
    }

    // Resolve project filter (identity-or-path) into the set of concrete
    // memory project_path values. Empty Vec is impossible because the helper
    // falls back to `[filter]` when no rows resolve.
    let resolved_paths: Vec<String> = if let Some(p) = project_filter {
        resolve_paths_for_memory_filter(conn, p)?
    } else {
        Vec::new()
    };
    if !resolved_paths.is_empty() {
        let start_idx = params.len() + 1;
        for path in &resolved_paths {
            params.push(Box::new(path.clone()));
        }
        let placeholders = build_in_placeholders(resolved_paths.len(), start_idx);
        conditions.push(format!("m.project_path IN ({})", placeholders));
    }
    if let Some(s) = status_filter {
        params.push(Box::new(s.to_string()));
        conditions.push(format!("m.status = ?{}", params.len()));
    }
    if let Some(c) = category_filter {
        params.push(Box::new(c.to_string()));
        conditions.push(format!("m.category = ?{}", params.len()));
    }

    let where_extra = if conditions.is_empty() {
        String::new()
    } else {
        format!("AND {}", conditions.join(" AND "))
    };

    // Add limit and offset
    let limit_idx = params.len() + 1;
    let offset_idx = params.len() + 2;
    params.push(Box::new(limit));
    params.push(Box::new(offset));

    let sql = if use_fts && !use_like_fallback {
        // FTS5 search with sanitized query
        format!(
            "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                    m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                    m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                    m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                    m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                    (CASE WHEN me.memory_id IS NOT NULL THEN 1 ELSE 0 END) as has_embedding
             FROM memories m
             LEFT JOIN memory_embeddings me ON me.memory_id = m.id
             INNER JOIN memories_fts ON memories_fts.rowid = m.id
             WHERE memories_fts MATCH ?1
             {}
             ORDER BY rank
             LIMIT ?{} OFFSET ?{}",
            where_extra, limit_idx, offset_idx,
        )
    } else if has_search {
        // LIKE fallback for short queries or special-character-heavy input
        format!(
            "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                    m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                    m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                    m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                    m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                    (CASE WHEN me.memory_id IS NOT NULL THEN 1 ELSE 0 END) as has_embedding
             FROM memories m
             LEFT JOIN memory_embeddings me ON me.memory_id = m.id
             WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.category LIKE ?1 ESCAPE '\\')
             {}
             ORDER BY m.updated_at DESC
             LIMIT ?{} OFFSET ?{}",
            where_extra, limit_idx, offset_idx,
        )
    } else {
        format!(
            "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                    m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                    m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                    m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                    m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                    (CASE WHEN me.memory_id IS NOT NULL THEN 1 ELSE 0 END) as has_embedding
             FROM memories m
             LEFT JOIN memory_embeddings me ON me.memory_id = m.id
             WHERE 1=1
             {}
             ORDER BY m.updated_at DESC
             LIMIT ?{} OFFSET ?{}",
            where_extra, limit_idx, offset_idx,
        )
    };

    // Try FTS first; if it fails (e.g. malformed query despite sanitization), fall back to LIKE
    let result = {
        let mut stmt = conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(param_refs.as_slice(), map_memory_row)?;
        rows.collect::<Result<Vec<_>, _>>()
    };

    match result {
        Ok(memories) if !memories.is_empty() || !use_fts => Ok(memories),
        Ok(_empty) if use_fts && !use_like_fallback => {
            // FTS returned nothing — retry with LIKE for better partial matching
            let like_sql = format!(
                "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                        m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                        m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                        m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                        m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                        (CASE WHEN me.memory_id IS NOT NULL THEN 1 ELSE 0 END) as has_embedding
                 FROM memories m
                 LEFT JOIN memory_embeddings me ON me.memory_id = m.id
                 WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.category LIKE ?1 ESCAPE '\\')
                 {}
                 ORDER BY m.updated_at DESC
                 LIMIT ?{} OFFSET ?{}",
                where_extra, limit_idx, offset_idx,
            );
            // Rebuild params with LIKE pattern instead of FTS query.
            // Project filter uses the same resolved_paths set computed at the
            // top of this function — the path-set is identity-stable for the
            // duration of this call.
            let mut like_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            like_params.push(Box::new(like_pattern));
            // Re-add filter params (matches the order used to build where_extra above)
            for path in &resolved_paths {
                like_params.push(Box::new(path.clone()));
            }
            if let Some(s) = status_filter {
                like_params.push(Box::new(s.to_string()));
            }
            if let Some(c) = category_filter {
                like_params.push(Box::new(c.to_string()));
            }
            like_params.push(Box::new(limit));
            like_params.push(Box::new(offset));

            let mut stmt = conn.prepare(&like_sql)?;
            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                like_params.iter().map(|p| p.as_ref()).collect();
            let rows = stmt.query_map(param_refs.as_slice(), map_memory_row)?;
            rows.collect()
        }
        Err(e) if use_fts => {
            // FTS query failed — fall back to LIKE
            eprintln!("FTS search failed, falling back to LIKE: {}", e);
            let like_sql = format!(
                "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                        m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                        m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                        m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                        m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                        (CASE WHEN me.memory_id IS NOT NULL THEN 1 ELSE 0 END) as has_embedding
                 FROM memories m
                 LEFT JOIN memory_embeddings me ON me.memory_id = m.id
                 WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.category LIKE ?1 ESCAPE '\\')
                 {}
                 ORDER BY m.updated_at DESC
                 LIMIT ?{} OFFSET ?{}",
                where_extra, limit_idx, offset_idx,
            );
            let mut like_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            like_params.push(Box::new(like_pattern));
            for path in &resolved_paths {
                like_params.push(Box::new(path.clone()));
            }
            if let Some(s) = status_filter {
                like_params.push(Box::new(s.to_string()));
            }
            if let Some(c) = category_filter {
                like_params.push(Box::new(c.to_string()));
            }
            like_params.push(Box::new(limit));
            like_params.push(Box::new(offset));

            let mut stmt = conn.prepare(&like_sql)?;
            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                like_params.iter().map(|p| p.as_ref()).collect();
            let rows = stmt.query_map(param_refs.as_slice(), map_memory_row)?;
            rows.collect()
        }
        other => other,
    }
}

fn map_memory_row(row: &rusqlite::Row<'_>) -> Result<Memory, rusqlite::Error> {
    Ok(Memory {
        id: row.get(0)?,
        project_path: row.get(1)?,
        category: row.get(2)?,
        content: row.get(3)?,
        normalized_hash: row.get(4)?,
        source_session_id: row.get(5)?,
        source_type: row.get(6)?,
        seen_count: row.get(7)?,
        retrieval_count: row.get(8)?,
        first_seen_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        last_seen_at: row.get(12)?,
        last_retrieved_at: row.get(13)?,
        status: row.get(14)?,
        expires_at: row.get(15)?,
        verification_status: row.get(16)?,
        verified_at: row.get(17)?,
        superseded_by_memory_id: row.get(18)?,
        merged_from: row.get(19)?,
        metadata_json: row.get(20)?,
        has_embedding: row.get::<_, i64>(21)? != 0,
    })
}

pub fn get_memory_stats(
    conn: &Connection,
    project_filter: Option<&str>,
) -> Result<MemoryStats, rusqlite::Error> {
    // Resolve project filter identity → concrete `project_path` set (see
    // `resolve_paths_for_memory_filter` doc comment for why this is needed).
    // Empty when no filter is provided; non-empty when filtering.
    let resolved_paths: Vec<String> = match project_filter {
        Some(p) => resolve_paths_for_memory_filter(conn, p)?,
        None => Vec::new(),
    };

    // Build a `project_path IN (?, ?, ...)` fragment and the param refs that
    // back it. Both are empty when no project filter is active.
    let (path_in_clause, path_params): (String, Vec<&dyn rusqlite::types::ToSql>) =
        if resolved_paths.is_empty() {
            (String::new(), Vec::new())
        } else {
            let placeholders = build_in_placeholders(resolved_paths.len(), 1);
            (
                format!("project_path IN ({})", placeholders),
                resolved_paths
                    .iter()
                    .map(|p| p as &dyn rusqlite::types::ToSql)
                    .collect(),
            )
        };

    // Helper: assemble the full WHERE clause for a query that may already
    // have other conditions. Returns `WHERE <conds>` or empty.
    let where_with_extra = |existing: &str, has_filter: bool| -> String {
        match (existing.is_empty(), has_filter) {
            (true, true) => format!("WHERE {}", path_in_clause),
            (false, true) => format!("WHERE {} AND {}", existing, path_in_clause),
            (true, false) => String::new(),
            (false, false) => format!("WHERE {}", existing),
        }
    };

    let has_filter = !resolved_paths.is_empty();

    let total: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM memories {}",
            where_with_extra("", has_filter)
        ),
        path_params.as_slice(),
        |r| r.get(0),
    )?;
    let active: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM memories {}",
            where_with_extra("status = 'active'", has_filter)
        ),
        path_params.as_slice(),
        |r| r.get(0),
    )?;
    let permanent: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM memories {}",
            where_with_extra("status = 'permanent'", has_filter)
        ),
        path_params.as_slice(),
        |r| r.get(0),
    )?;
    let archived: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM memories {}",
            where_with_extra("status = 'archived'", has_filter)
        ),
        path_params.as_slice(),
        |r| r.get(0),
    )?;

    // Embeddings count joins through memories to honor the project filter.
    // Without a filter, count rows in the embeddings table directly (fastest).
    let with_embeddings: i64 = if has_filter {
        // Rewrite the IN clause to be qualified to `m.project_path` for the
        // JOIN — placeholders stay at indices 1..=N so we can reuse path_params.
        let qualified_in = format!(
            "m.project_path IN ({})",
            build_in_placeholders(resolved_paths.len(), 1)
        );
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM memory_embeddings me JOIN memories m ON me.memory_id = m.id WHERE {}",
                qualified_in
            ),
            path_params.as_slice(),
            |r| r.get(0),
        )?
    } else {
        conn.query_row("SELECT COUNT(*) FROM memory_embeddings", [], |r| r.get(0))?
    };

    let cat_sql = format!(
        "SELECT category, COUNT(*) as cnt FROM memories {} GROUP BY category ORDER BY cnt DESC",
        where_with_extra("status != 'archived'", has_filter)
    );
    let mut stmt = conn.prepare(&cat_sql)?;
    let categories: Vec<CategoryCount> = stmt
        .query_map(path_params.as_slice(), |row| {
            Ok(CategoryCount {
                category: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(MemoryStats {
        total,
        active,
        permanent,
        archived,
        with_embeddings,
        categories,
    })
}

fn mutation_race_error() -> rusqlite::Error {
    rusqlite::Error::InvalidQuery
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MemoryMutationTarget {
    project_path: String,
    category: Option<String>,
    status: Option<String>,
}

fn lookup_memory_mutation_target(
    conn: &Connection,
    memory_id: i64,
) -> Result<MemoryMutationTarget, rusqlite::Error> {
    conn.query_row(
        "SELECT project_path, category, status FROM memories WHERE id = ?1",
        params![memory_id],
        |row| {
            Ok(MemoryMutationTarget {
                project_path: row.get(0)?,
                category: row.get(1)?,
                status: row.get(2)?,
            })
        },
    )
}

fn fetch_memory_mutation_targets(
    conn: &Connection,
    memory_ids: &[i64],
) -> Result<HashMap<i64, MemoryMutationTarget>, rusqlite::Error> {
    if memory_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let placeholders = memory_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, project_path, category, status FROM memories WHERE id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(memory_ids.iter()), |row| {
        Ok((
            row.get::<_, i64>(0)?,
            MemoryMutationTarget {
                project_path: row.get(1)?,
                category: row.get(2)?,
                status: row.get(3)?,
            },
        ))
    })?;

    rows.collect::<Result<HashMap<_, _>, _>>()
}

fn fetch_memory_project_paths_in_tx(
    tx: &Transaction<'_>,
    memory_ids: &[i64],
) -> Result<HashMap<i64, String>, rusqlite::Error> {
    if memory_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let placeholders = memory_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!("SELECT id, project_path FROM memories WHERE id IN ({placeholders})");
    let mut stmt = tx.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(memory_ids.iter()), |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;

    rows.collect::<Result<HashMap<_, _>, _>>()
}

fn normalize_memory_project_identities(paths: &HashMap<i64, String>) -> HashSet<String> {
    paths
        .values()
        .map(|stored| normalize_stored_project_path(stored))
        .filter(|identity| !identity.is_empty())
        .collect()
}

fn verify_memory_project_path_unchanged(
    tx: &Transaction<'_>,
    memory_id: i64,
    expected: &str,
) -> Result<(), rusqlite::Error> {
    let current: Option<String> = tx
        .query_row(
            "SELECT project_path FROM memories WHERE id = ?1",
            params![memory_id],
            |row| row.get(0),
        )
        .optional()?;

    if current.as_deref() == Some(expected) {
        Ok(())
    } else {
        Err(mutation_race_error())
    }
}

fn verify_bulk_memory_project_paths_unchanged(
    tx: &Transaction<'_>,
    expected: &HashMap<i64, String>,
) -> Result<(), rusqlite::Error> {
    if expected.is_empty() {
        return Ok(());
    }

    let mut ids: Vec<i64> = expected.keys().copied().collect();
    ids.sort_unstable();
    let current = fetch_memory_project_paths_in_tx(tx, &ids)?;
    if current == *expected {
        Ok(())
    } else {
        Err(mutation_race_error())
    }
}

fn bump_project_memory_epoch_for_identity(
    tx: &Transaction<'_>,
    identity: &str,
) -> Result<(), rusqlite::Error> {
    if identity.is_empty() {
        return Ok(());
    }

    tx.execute(
        "INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version, updated_at)
         VALUES (?1, 1, 0, ?2)
         ON CONFLICT(project_path) DO UPDATE SET
           project_memory_epoch = project_memory_epoch + 1,
           updated_at = excluded.updated_at",
        params![identity, now_millis()],
    )?;
    Ok(())
}

fn queue_memory_mutation(
    tx: &Transaction<'_>,
    project_path: &str,
    mutation_type: &str,
    target_memory_id: i64,
    superseded_by_id: Option<i64>,
    category: Option<&str>,
    new_content: Option<&str>,
) -> Result<(), rusqlite::Error> {
    // Store the row under the resolved identity (git:/dir:), mirroring the plugin's
    // queueMemoryMutation. The render-side filter queries by resolved identity, so a
    // raw-path row would be invisible to it. Idempotent on already-resolved paths
    // (every live memory row), defensive for any legacy raw path.
    let identity = normalize_stored_project_path(project_path);
    tx.execute(
        "INSERT INTO memory_mutation_log
           (project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            identity,
            mutation_type,
            target_memory_id,
            superseded_by_id,
            category,
            new_content,
            now_millis()
        ],
    )?;
    Ok(())
}

fn bump_project_user_profile_version(tx: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    tx.execute(
        "INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version, updated_at)
         VALUES ('__global__', 0, 1, ?1)
         ON CONFLICT(project_path) DO UPDATE SET
           project_user_profile_version = project_user_profile_version + 1,
           updated_at = excluded.updated_at",
        params![now_millis()],
    )?;
    Ok(())
}

fn lookup_session_fact_session_id(
    conn: &Connection,
    fact_id: i64,
) -> Result<String, rusqlite::Error> {
    conn.query_row(
        "SELECT session_id FROM session_facts WHERE id = ?1",
        params![fact_id],
        |row| row.get(0),
    )
}

fn verify_session_fact_session_unchanged(
    tx: &Transaction<'_>,
    fact_id: i64,
    expected_session_id: &str,
) -> Result<(), rusqlite::Error> {
    let current: Option<String> = tx
        .query_row(
            "SELECT session_id FROM session_facts WHERE id = ?1",
            params![fact_id],
            |row| row.get(0),
        )
        .optional()?;

    if current.as_deref() == Some(expected_session_id) {
        Ok(())
    } else {
        Err(mutation_race_error())
    }
}

fn bump_session_facts_version_for_session(
    tx: &Transaction<'_>,
    session_id: &str,
) -> Result<(), rusqlite::Error> {
    tx.execute(
        "INSERT INTO session_meta (session_id, session_facts_version)
         VALUES (?1, 1)
         ON CONFLICT(session_id) DO UPDATE SET
           session_facts_version = session_facts_version + 1",
        params![session_id],
    )?;
    Ok(())
}

/// Exception-only cache invalidation for schema/cache-format upgrades and explicit clear-all UI.
/// Routine memory, user-memory, and fact mutations must use scoped version counters instead.
pub fn invalidate_all_memory_block_caches(conn: &Connection) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE session_meta
         SET memory_block_cache = '',
             memory_block_ids = '',
             cached_m0_bytes = NULL,
             cached_m1_bytes = NULL,
             cached_m0_max_memory_mutation_id = NULL
         WHERE memory_block_cache != ''
            OR memory_block_ids != ''
            OR cached_m0_bytes IS NOT NULL
            OR cached_m1_bytes IS NOT NULL
            OR cached_m0_max_memory_mutation_id IS NOT NULL",
        [],
    )
}

pub fn update_memory_status(
    conn: &mut Connection,
    memory_id: i64,
    new_status: &str,
) -> Result<(), rusqlite::Error> {
    // Phase A: resolve the target row before opening a write transaction.
    let target = lookup_memory_mutation_target(conn, memory_id)?;
    let is_restore = new_status == "active" && target.status.as_deref() == Some("archived");
    let project_identity = if is_restore {
        Some(normalize_stored_project_path(&target.project_path))
    } else {
        None
    };
    let is_archive = new_status == "archived" && target.status.as_deref() != Some("archived");

    // Phase B: re-check the target row, mutate, and queue/bump in one tx.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    verify_memory_project_path_unchanged(&tx, memory_id, &target.project_path)?;
    tx.execute(
        "UPDATE memories SET status = ?1, updated_at = ?2 WHERE id = ?3",
        params![new_status, now_millis(), memory_id],
    )?;
    if let Some(project_identity) = project_identity.as_deref() {
        bump_project_memory_epoch_for_identity(&tx, project_identity)?;
    } else if is_archive {
        queue_memory_mutation(
            &tx,
            &target.project_path,
            "archive",
            memory_id,
            None,
            target.category.as_deref(),
            None,
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn update_memory_content(
    conn: &mut Connection,
    memory_id: i64,
    new_content: &str,
) -> Result<(), rusqlite::Error> {
    // Phase A: resolve the target row before opening a write transaction.
    let target = lookup_memory_mutation_target(conn, memory_id)?;
    let new_hash = normalize_hash(new_content);

    // Phase B: re-check the target row, mutate, clear stale embeddings, and queue once.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    verify_memory_project_path_unchanged(&tx, memory_id, &target.project_path)?;
    tx.execute(
        "UPDATE memories SET content = ?1, normalized_hash = ?2, updated_at = ?3 WHERE id = ?4",
        params![new_content, new_hash, now_millis(), memory_id],
    )?;
    tx.execute(
        "DELETE FROM memory_embeddings WHERE memory_id = ?1",
        params![memory_id],
    )?;
    queue_memory_mutation(
        &tx,
        &target.project_path,
        "update",
        memory_id,
        None,
        target.category.as_deref(),
        Some(new_content),
    )?;
    tx.commit()?;
    Ok(())
}

pub fn delete_memory(conn: &mut Connection, memory_id: i64) -> Result<(), rusqlite::Error> {
    // Phase A: resolve the target row before opening a write transaction.
    let target = lookup_memory_mutation_target(conn, memory_id)?;

    // Phase B: re-check, queue before delete, then delete.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    verify_memory_project_path_unchanged(&tx, memory_id, &target.project_path)?;
    queue_memory_mutation(
        &tx,
        &target.project_path,
        "delete",
        memory_id,
        None,
        target.category.as_deref(),
        None,
    )?;
    tx.execute(
        "DELETE FROM memory_embeddings WHERE memory_id = ?1",
        params![memory_id],
    )?;
    tx.execute("DELETE FROM memories WHERE id = ?1", params![memory_id])?;
    tx.commit()?;
    Ok(())
}

/// Bulk-update status for a set of memory IDs in one transaction.
///
/// Empty input is a no-op and returns 0 (affected rows).
pub fn bulk_update_memory_status(
    conn: &mut Connection,
    memory_ids: &[i64],
    new_status: &str,
) -> Result<usize, rusqlite::Error> {
    if memory_ids.is_empty() {
        return Ok(0);
    }

    // Phase A: one read round-trip for all target rows, then identity normalization lock-free.
    let phase_a_targets = fetch_memory_mutation_targets(conn, memory_ids)?;
    let phase_a_paths: HashMap<i64, String> = phase_a_targets
        .iter()
        .map(|(id, target)| (*id, target.project_path.clone()))
        .collect();
    let is_restore = new_status == "active";
    let is_archive = new_status == "archived";
    let phase_a_identities = if is_restore {
        normalize_memory_project_identities(&phase_a_paths)
    } else {
        HashSet::new()
    };

    let placeholders = memory_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql =
        format!("UPDATE memories SET status = ?, updated_at = ? WHERE id IN ({placeholders})");
    let now = now_millis();

    // Phase B: bulk re-verify, bulk update, then queue per archive or bump per restore.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    verify_bulk_memory_project_paths_unchanged(&tx, &phase_a_paths)?;
    let affected = {
        let status_value = new_status.to_string();
        let mut params_vec: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(2 + memory_ids.len());
        params_vec.push(&status_value);
        params_vec.push(&now);
        for id in memory_ids {
            params_vec.push(id);
        }
        tx.execute(&sql, params_from_iter(params_vec))?
    };
    if is_restore {
        for identity in &phase_a_identities {
            bump_project_memory_epoch_for_identity(&tx, identity)?;
        }
    } else if is_archive {
        for id in memory_ids {
            if let Some(target) = phase_a_targets.get(id) {
                if target.status.as_deref() != Some("archived") {
                    queue_memory_mutation(
                        &tx,
                        &target.project_path,
                        "archive",
                        *id,
                        None,
                        target.category.as_deref(),
                        None,
                    )?;
                }
            }
        }
    }
    tx.commit()?;
    Ok(affected)
}

/// Bulk-delete memories and their embeddings in one transaction.
pub fn bulk_delete_memory(
    conn: &mut Connection,
    memory_ids: &[i64],
) -> Result<usize, rusqlite::Error> {
    if memory_ids.is_empty() {
        return Ok(0);
    }

    // Phase A: one read round-trip for all target rows, then identity normalization lock-free.
    let phase_a_targets = fetch_memory_mutation_targets(conn, memory_ids)?;
    let phase_a_paths: HashMap<i64, String> = phase_a_targets
        .iter()
        .map(|(id, target)| (*id, target.project_path.clone()))
        .collect();
    let placeholders = memory_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");

    // Phase B: bulk re-verify, queue one delete per memory, then delete.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    verify_bulk_memory_project_paths_unchanged(&tx, &phase_a_paths)?;
    for id in memory_ids {
        if let Some(target) = phase_a_targets.get(id) {
            queue_memory_mutation(
                &tx,
                &target.project_path,
                "delete",
                *id,
                None,
                target.category.as_deref(),
                None,
            )?;
        }
    }
    {
        let sql = format!("DELETE FROM memory_embeddings WHERE memory_id IN ({placeholders})");
        tx.execute(&sql, params_from_iter(memory_ids.iter()))?;
    }
    let affected = {
        let sql = format!("DELETE FROM memories WHERE id IN ({placeholders})");
        tx.execute(&sql, params_from_iter(memory_ids.iter()))?
    };
    tx.commit()?;
    Ok(affected)
}

// ── Session queries ─────────────────────────────────────────

pub fn get_sessions(conn: &Connection) -> Result<Vec<SessionSummary>, rusqlite::Error> {
    let sql = "
        WITH comp_stats AS (
            SELECT session_id,
                   COUNT(*) AS cnt,
                   MIN(start_message) AS first_start,
                   MAX(end_message) AS last_end
            FROM compartments GROUP BY session_id
        ),
        fact_stats AS (
            SELECT session_id, COUNT(*) AS cnt FROM session_facts GROUP BY session_id
        ),
        note_stats AS (
            SELECT session_id, COUNT(*) AS cnt FROM notes WHERE type = 'session' AND status = 'active' GROUP BY session_id
        )
        SELECT
            sm.session_id,
            COALESCE(cs.cnt, 0),
            COALESCE(fs.cnt, 0),
            COALESCE(ns.cnt, 0),
            cs.first_start,
            cs.last_end,
            sm.last_response_time,
            sm.last_context_percentage,
            sm.is_subagent
        FROM session_meta sm
        LEFT JOIN comp_stats cs ON cs.session_id = sm.session_id
        LEFT JOIN fact_stats fs ON fs.session_id = sm.session_id
        LEFT JOIN note_stats ns ON ns.session_id = sm.session_id
        ORDER BY sm.last_response_time DESC NULLS LAST
    ";
    let mut stmt = conn.prepare(sql)?;
    let mut sessions: Vec<SessionSummary> = stmt
        .query_map([], |row| {
            Ok(SessionSummary {
                session_id: row.get(0)?,
                title: None,
                project_identity: None,
                compartment_count: row.get(1)?,
                fact_count: row.get(2)?,
                note_count: row.get(3)?,
                first_compartment_start: row.get(4)?,
                last_compartment_end: row.get(5)?,
                last_response_time: row.get(6)?,
                last_context_percentage: row.get(7)?,
                is_subagent: row.get::<_, i64>(8)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Resolve session titles and project IDs from OpenCode's DB
    let session_info = resolve_session_info(&sessions);
    for session in &mut sessions {
        if let Some(info) = session_info.get(&session.session_id) {
            session.title = Some(info.0.clone());
            if !info.1.is_empty() {
                session.project_identity = Some(format!("git:{}", info.1));
            }
        }
    }

    Ok(sessions)
}

pub fn list_opencode_sessions(filter: &SessionFilter) -> Vec<SessionRow> {
    if filter.harness.is_some_and(|h| h != Harness::Opencode) {
        return Vec::new();
    }
    let Some(opencode_db_path) = resolve_opencode_db_path() else {
        return Vec::new();
    };
    let Ok(conn) = open_readonly(&opencode_db_path) else {
        return Vec::new();
    };
    // No message-table join: the session list does not show a message count, and
    // joining/grouping the 300k+ row `message` table per call was the dominant
    // cost (a multi-hundred-ms scan that froze the UI on every History entry).
    // `session.time_updated` is the session's own last-activity timestamp.
    let Ok(mut stmt) = conn.prepare(
        "SELECT s.id, COALESCE(s.title, ''), COALESCE(p.name, ''), COALESCE(p.worktree, ''),
                s.time_updated AS last_activity
         FROM session s
         LEFT JOIN project p ON p.id = s.project_id",
    ) else {
        return Vec::new();
    };

    // Look up the real `is_subagent` flag from Magic Context's session_meta
    // table for this harness. Sessions that have never been touched by the
    // plugin (very rare in practice for OpenCode sessions, since the plugin
    // tags every session on first prompt) default to `false`, matching the
    // "primary session" assumption.
    let subagent_map = load_subagent_map_for_harness(Harness::Opencode);

    let rows = stmt.query_map([], |row| {
        let session_id: String = row.get(0)?;
        let title: String = row.get(1)?;
        let project_name: String = row.get(2)?;
        let worktree: String = row.get(3)?;
        let last_activity_ms: i64 = row.get(4)?;
        let identity = resolve_project_identity(&worktree);
        let is_subagent = subagent_map.get(&session_id).copied().unwrap_or(false);
        Ok(SessionRow {
            harness: Harness::Opencode,
            session_id,
            title,
            project_identity: identity,
            project_display: if project_name.is_empty() {
                basename(&worktree)
            } else {
                project_name
            },
            last_activity_ms,
            is_subagent,
        })
    });

    rows.map(|rows| {
        rows.flatten()
            .filter(|row| session_matches_filter(row, filter))
            .collect()
    })
    .unwrap_or_default()
}

pub fn list_pi_sessions(filter: &SessionFilter) -> Vec<SessionRow> {
    if filter.harness.is_some_and(|h| h != Harness::Pi) {
        return Vec::new();
    }
    let subagent_map = load_subagent_map_for_harness(Harness::Pi);
    pi_sessions::scan_pi_session_dir()
        .into_iter()
        .map(|meta| {
            let project_identity = resolve_project_identity(&meta.cwd);
            let is_subagent = subagent_map.get(&meta.session_id).copied().unwrap_or(false);
            SessionRow {
                harness: Harness::Pi,
                session_id: meta.session_id,
                title: clean_pi_title(meta.session_name, &meta.first_message),
                project_identity,
                project_display: basename(&meta.cwd),
                last_activity_ms: meta.modified,
                is_subagent,
            }
        })
        .filter(|row| session_matches_filter(row, filter))
        .collect()
}

pub fn list_all_sessions(filter: SessionFilter) -> Vec<SessionRow> {
    let mut rows = Vec::new();
    rows.extend(list_opencode_sessions(&filter));
    rows.extend(list_pi_sessions(&filter));
    rows.sort_by_key(|row| std::cmp::Reverse(row.last_activity_ms));
    rows
}

pub fn list_sessions_paged(filter: SessionFilter) -> PagedSessions {
    let rows = list_all_sessions(filter.clone());
    page_session_rows(rows, filter.offset, filter.limit)
}

fn page_session_rows(
    rows: Vec<SessionRow>,
    offset: Option<u32>,
    limit: Option<u32>,
) -> PagedSessions {
    let total_usize = rows.len();
    let offset_usize = offset.unwrap_or(0) as usize;
    let limit_usize = limit.map(|value| value as usize).unwrap_or(total_usize);
    let paged_rows: Vec<SessionRow> = rows
        .into_iter()
        .skip(offset_usize)
        .take(limit_usize)
        .collect();
    let consumed = offset_usize.saturating_add(paged_rows.len());

    PagedSessions {
        rows: paged_rows,
        total: total_usize as u32,
        has_more: consumed < total_usize,
    }
}

fn session_matches_filter(row: &SessionRow, filter: &SessionFilter) -> bool {
    if let Some(identity) = filter.project_identity.as_deref() {
        if row.project_identity != identity {
            return false;
        }
    }
    if let Some(search) = filter
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let search = search.to_ascii_lowercase();
        let haystack = format!("{} {} {}", row.title, row.project_display, row.session_id)
            .to_ascii_lowercase();
        if !haystack.contains(&search) {
            return false;
        }
    }
    if let Some(want_subagent) = filter.is_subagent {
        if row.is_subagent != want_subagent {
            return false;
        }
    }
    true
}

/// Load `{session_id -> is_subagent}` from the Magic Context `session_meta`
/// table for the given harness. Returns an empty map on any DB error so a
/// missing cortexkit DB never crashes the dashboard — sessions then default
/// to `is_subagent=false` and the user simply sees no filtering until the
/// plugin's first run populates the table.
fn load_subagent_map_for_harness(harness: Harness) -> std::collections::HashMap<String, bool> {
    use std::collections::HashMap;
    let mut map: HashMap<String, bool> = HashMap::new();
    let Some(db_path) = resolve_db_path() else {
        return map;
    };
    let Ok(conn) = open_readonly(&db_path) else {
        return map;
    };
    let harness_str = match harness {
        Harness::Opencode => "opencode",
        Harness::Pi => "pi",
    };
    let Ok(mut stmt) =
        conn.prepare("SELECT session_id, is_subagent FROM session_meta WHERE harness = ?1")
    else {
        return map;
    };
    let rows = stmt.query_map([harness_str], |row| {
        let sid: String = row.get(0)?;
        let flag: i64 = row.get(1)?;
        Ok((sid, flag != 0))
    });
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            map.insert(row.0, row.1);
        }
    }
    map
}

pub fn get_session_detail(
    conn: Option<&Connection>,
    harness: Harness,
    session_id: &str,
) -> Result<Option<SessionDetail>, rusqlite::Error> {
    match harness {
        Harness::Opencode => get_opencode_session_detail(conn, session_id),
        Harness::Pi => Ok(get_pi_session_detail(conn, session_id)),
    }
}

/// Lazy message-list fetch for the Messages tab. Separated from
/// `get_session_detail` so opening a session doesn't pay the cost of
/// JSON-extracting role + aggregating `part` text for tens of thousands of
/// rows when the user lands on Compartments. Pi side reuses the mtime-cached
/// JSONL view, so a second call after `get_session_detail` is essentially free.
pub fn get_session_messages(
    harness: Harness,
    session_id: &str,
) -> Result<Vec<SessionMessageRow>, rusqlite::Error> {
    match harness {
        Harness::Opencode => {
            let Some(opencode_db_path) = resolve_opencode_db_path() else {
                return Ok(Vec::new());
            };
            let conn = open_readonly(&opencode_db_path)?;
            load_opencode_messages(&conn, session_id)
        }
        Harness::Pi => {
            let Some(path) = pi_sessions::find_pi_session_path(session_id) else {
                return Ok(Vec::new());
            };
            let Some(detail) = pi_sessions::read_pi_session_detail(&path) else {
                return Ok(Vec::new());
            };
            Ok(detail
                .messages
                .iter()
                .map(|message| SessionMessageRow {
                    message_id: message.entry_id.clone(),
                    timestamp_ms: message.timestamp_ms,
                    role: message.role.clone(),
                    text_preview: message.text_preview.clone(),
                    raw_json: message.raw_json.clone(),
                })
                .collect())
        }
    }
}

pub fn get_project_key_files(
    conn: &Connection,
    project_path: &str,
) -> Result<Vec<KeyFileRow>, rusqlite::Error> {
    let version: i64 = conn
        .query_row(
            "SELECT version FROM project_key_files_version WHERE project_path = ?1",
            [project_path],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let mut stmt = conn.prepare(
        "SELECT project_path, path, content, content_hash, local_token_estimate,
                generated_at, generated_by_model, generation_config_hash, stale_reason
           FROM project_key_files
          WHERE project_path = ?1
          ORDER BY generated_at DESC, path ASC",
    )?;
    let rows = stmt.query_map([project_path], |row| {
        Ok(KeyFileRow {
            project_path: row.get(0)?,
            path: row.get(1)?,
            content: row.get(2)?,
            content_hash: row.get(3)?,
            local_token_estimate: row.get(4)?,
            generated_at: row.get(5)?,
            generated_by_model: row.get(6)?,
            generation_config_hash: row.get(7)?,
            stale_reason: row.get(8)?,
            version,
        })
    })?;
    rows.collect()
}

pub fn get_opencode_session_detail(
    conn: Option<&Connection>,
    session_id: &str,
) -> Result<Option<SessionDetail>, rusqlite::Error> {
    let Some(opencode_db_path) = resolve_opencode_db_path() else {
        return Ok(None);
    };
    let oc_conn = open_readonly(&opencode_db_path)?;
    let row = oc_conn.query_row(
        "SELECT s.id, COALESCE(s.title, ''), COALESCE(p.name, ''), COALESCE(p.worktree, ''),
                COALESCE(json_object('id', s.id, 'title', s.title, 'directory', s.directory), '{}')
         FROM session s LEFT JOIN project p ON p.id = s.project_id WHERE s.id = ?1",
        [session_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        },
    );
    let Ok((session_id, title, project_name, worktree, data_json)) = row else {
        return Ok(None);
    };

    // Cheap row counts for badge rendering. Both are O(rows-in-session) at
    // worst but use only INTEGER aggregates (no JSON extraction or part-table
    // join), so they're <20ms even for 37k-message sessions.
    let messages_count: i64 = oc_conn
        .query_row(
            "SELECT COUNT(*) FROM message WHERE session_id = ?1",
            [&session_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let cache_events_count: i64 = oc_conn
        .query_row(
            "SELECT COUNT(*) FROM message
             WHERE session_id = ?1
               AND json_extract(data, '$.role') = 'assistant'
               AND COALESCE(CAST(json_extract(data, '$.tokens.total') AS INTEGER), 0) > 0",
            [&session_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let compartments = conn
        .map(|c| get_compartments(c, &session_id))
        .transpose()?
        .unwrap_or_default();
    let facts = conn
        .map(|c| get_session_facts(c, &session_id))
        .transpose()?
        .unwrap_or_default();
    let notes = conn
        .map(|c| get_session_notes(c, &session_id))
        .transpose()?
        .unwrap_or_default();
    let meta = conn
        .map(|c| get_session_meta(c, &session_id))
        .transpose()?
        .flatten();
    let token_breakdown = conn
        .map(|c| get_context_token_breakdown(c, &session_id))
        .transpose()?
        .flatten();

    Ok(Some(SessionDetail {
        harness: Harness::Opencode,
        session_id,
        title,
        project_identity: resolve_project_identity(&worktree),
        project_display: if project_name.is_empty() {
            basename(&worktree)
        } else {
            project_name
        },
        project_path: (!worktree.is_empty()).then_some(worktree),
        opencode_session_json: serde_json::from_str(&data_json).ok(),
        pi_jsonl_path: None,
        messages_count,
        cache_events_count,
        compartments,
        facts,
        notes,
        meta,
        token_breakdown,
        pi_compaction_entries: Vec::new(),
    }))
}

fn load_opencode_messages(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SessionMessageRow>, rusqlite::Error> {
    // OpenCode stores message metadata (role, time, agent, model) on the `message` table
    // but the actual text content lives in the separate `part` table joined by `message_id`.
    // Each part has its own JSON shape — `type=text` parts have a `text` field; other types
    // (`tool`, `step-start`, `step-finish`, `reasoning`, `file`) are not user-visible content.
    //
    // We aggregate text parts per message via GROUP_CONCAT for a single round-trip query
    // instead of N+1. Parts are ordered by `time_created` then `id` to preserve sequence.
    //
    // The `||` operator concatenates SQL strings; `||` with NULL produces NULL, so we wrap
    // json_extract in COALESCE to handle non-text parts (which return NULL for `$.text`).
    let mut stmt = conn.prepare(
        "SELECT
            CAST(m.id AS TEXT),
            m.time_created,
            COALESCE(CAST(json_extract(m.data, '$.role') AS TEXT), ''),
            m.data,
            COALESCE(
                (SELECT GROUP_CONCAT(json_extract(p.data, '$.text'), ' ')
                 FROM part p
                 WHERE p.message_id = m.id
                   AND json_extract(p.data, '$.type') = 'text'
                   AND json_extract(p.data, '$.text') IS NOT NULL),
                ''
            ) AS aggregated_text
         FROM message m
         WHERE m.session_id = ?1
         ORDER BY m.time_created ASC",
    )?;
    let rows = stmt.query_map([session_id], |row| {
        let raw_string: String = row.get(3)?;
        let raw_json: serde_json::Value = serde_json::from_str(&raw_string).unwrap_or_default();
        let aggregated_text: String = row.get(4)?;
        // Use aggregated parts text when present; fall back to legacy in-message content
        // (covers any future schema variants where text might live on the message row).
        let text_preview = if aggregated_text.is_empty() {
            preview_from_json(&raw_json)
        } else {
            normalize_preview(&aggregated_text)
        };
        Ok(SessionMessageRow {
            message_id: row.get(0)?,
            timestamp_ms: row.get(1)?,
            role: row.get(2)?,
            text_preview,
            raw_json,
        })
    })?;
    rows.collect()
}

/// Resolve a clean Pi session title.
///
/// Pi sessions migrated from OpenCode have a synthetic first user message that begins
/// with `<!-- migrated from OpenCode session ... -->`. When no explicit `session.name`
/// is present, that banner leaks through as the displayed title. Strip the comment +
/// boilerplate and use whatever real text follows it (often empty in practice). If
/// nothing useful remains, fall back to a short, readable placeholder.
fn clean_pi_title(session_name: Option<String>, first_message: &str) -> String {
    if let Some(name) = session_name.filter(|n| !n.trim().is_empty()) {
        return name;
    }
    let trimmed = first_message.trim_start();
    if !trimmed.starts_with("<!--") {
        return first_message.to_string();
    }
    // Strip a single `<!-- ... -->` HTML comment, then the migration boilerplate sentence
    // that the migrate command always appends after the comment.
    let after_comment = trimmed
        .find("-->")
        .map(|idx| trimmed[idx + 3..].trim_start().to_string())
        .unwrap_or_default();
    const MIGRATION_BOILERPLATE: &str = "The following conversation was migrated from a different harness. Reasoning context from prior turns may be incomplete; tool calls reference tools that may not exist in this environment.";
    let stripped = after_comment
        .strip_prefix(MIGRATION_BOILERPLATE)
        .map(|rest| rest.trim_start().to_string())
        .unwrap_or(after_comment);
    if stripped.trim().is_empty() {
        "Migrated session".to_string()
    } else {
        stripped
    }
}

/// Normalize and truncate text for preview: collapse whitespace, drop control characters,
/// and cap at 500 chars. Mirrors `preview_from_json` final pass for consistency.
fn normalize_preview(text: &str) -> String {
    text.chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(500)
        .collect()
}

pub fn get_pi_session_detail(conn: Option<&Connection>, session_id: &str) -> Option<SessionDetail> {
    let path = pi_sessions::find_pi_session_path(session_id)?;
    let detail = pi_sessions::read_pi_session_detail(&path)?;
    let title = clean_pi_title(detail.meta.session_name.clone(), &detail.meta.first_message);

    // Counts come from the already-parsed (and mtime-cached) JSONL view, so
    // they're free. `cache_events_count` matches `get_pi_session_cache_events`
    // filter exactly: assistant messages with usage.total > 0.
    let messages_count = detail.messages.len() as i64;
    let cache_events_count = detail
        .messages
        .iter()
        .filter(|m| m.role == "assistant")
        .filter(|m| m.usage.as_ref().is_some_and(|u| u.total > 0))
        .count() as i64;

    let compartments = conn
        .and_then(|c| get_compartments(c, session_id).ok())
        .unwrap_or_default();
    let facts = conn
        .and_then(|c| get_session_facts(c, session_id).ok())
        .unwrap_or_default();
    let notes = conn
        .and_then(|c| get_session_notes(c, session_id).ok())
        .unwrap_or_default();
    let meta = conn
        .and_then(|c| get_session_meta(c, session_id).ok())
        .flatten();
    let token_breakdown = conn
        .and_then(|c| get_context_token_breakdown(c, session_id).ok())
        .flatten();
    let project_identity = resolve_project_identity(&detail.meta.cwd);
    Some(SessionDetail {
        harness: Harness::Pi,
        session_id: detail.meta.session_id.clone(),
        title,
        project_identity,
        project_display: basename(&detail.meta.cwd),
        project_path: (!detail.meta.cwd.is_empty()).then_some(detail.meta.cwd.clone()),
        opencode_session_json: None,
        pi_jsonl_path: Some(detail.meta.jsonl_path.to_string_lossy().to_string()),
        messages_count,
        cache_events_count,
        compartments,
        facts,
        notes,
        meta,
        token_breakdown,
        pi_compaction_entries: detail.compaction_entries,
    })
}

fn preview_from_json(value: &serde_json::Value) -> String {
    fn content_text(value: &serde_json::Value) -> String {
        if let Some(text) = value.as_str() {
            return text.to_string();
        }
        if let Some(parts) = value.as_array() {
            return parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .and_then(serde_json::Value::as_str)
                        .map(ToString::to_string)
                })
                .collect::<Vec<_>>()
                .join(" ");
        }
        String::new()
    }
    let text = value
        .get("content")
        .map(content_text)
        .or_else(|| value.get("parts").map(content_text))
        .unwrap_or_default();
    text.chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(500)
        .collect()
}

/// Look up session titles and project IDs from OpenCode's database.
/// Returns HashMap<session_id, (title, project_id)>.
fn resolve_session_info(
    sessions: &[SessionSummary],
) -> std::collections::HashMap<String, (String, String)> {
    let mut result = HashMap::new();
    if sessions.is_empty() {
        return result;
    }

    let Some(opencode_db) = resolve_opencode_db_path() else {
        return result;
    };

    let conn = match open_readonly(&opencode_db) {
        Ok(c) => c,
        Err(_) => return result,
    };

    let mut stmt = match conn.prepare("SELECT id, title, project_id FROM session") {
        Ok(s) => s,
        Err(_) => return result,
    };

    if let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) {
        for row in rows.flatten() {
            result.insert(row.0, (row.1, row.2));
        }
    }

    result
}

pub fn get_compartments(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<Compartment>, rusqlite::Error> {
    // v2 tiered compartments: read the paraphrase tiers (p1–p4), the
    // decay-rate `importance`, and `episode_type` directly off the row.
    // `legacy=1` rows predate the tiered format (p1–p4 NULL) and render
    // degraded on the frontend. `content` mirrors p1 for v2 rows.
    let mut stmt = conn.prepare(
        "SELECT c.id, c.session_id, c.sequence, c.start_message, c.end_message,
                c.start_message_id, c.end_message_id, c.title, c.content, c.created_at,
                c.importance, c.episode_type, c.p1, c.p2, c.p3, c.p4, c.legacy
         FROM compartments c
         WHERE c.session_id = ?1
         ORDER BY c.sequence DESC",
    )?;
    let mut compartments: Vec<Compartment> = stmt
        .query_map(rusqlite::params![session_id], |row| {
            Ok(Compartment {
                id: row.get(0)?,
                session_id: row.get(1)?,
                sequence: row.get(2)?,
                start_message: row.get(3)?,
                end_message: row.get(4)?,
                start_message_id: row.get(5)?,
                end_message_id: row.get(6)?,
                title: row.get(7)?,
                content: row.get(8)?,
                created_at: row.get(9)?,
                start_time: None,
                end_time: None,
                importance: row.get::<_, Option<i64>>(10)?.unwrap_or(50),
                episode_type: row.get(11)?,
                p1: row.get(12)?,
                p2: row.get(13)?,
                p3: row.get(14)?,
                p4: row.get(15)?,
                legacy: row.get::<_, Option<i64>>(16)?.unwrap_or(0),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Resolve message timestamps from OpenCode DB
    if let Some(opencode_db_path) = resolve_opencode_db_path() {
        if let Ok(oc_conn) = open_readonly(&opencode_db_path) {
            for comp in compartments.iter_mut() {
                if let Some(ref start_id) = comp.start_message_id {
                    if let Ok(ts) = oc_conn.query_row(
                        "SELECT time_created FROM message WHERE id = ?1",
                        rusqlite::params![start_id],
                        |row| row.get::<_, Option<i64>>(0),
                    ) {
                        comp.start_time = ts;
                    }
                }
                if let Some(ref end_id) = comp.end_message_id {
                    if let Ok(ts) = oc_conn.query_row(
                        "SELECT time_created FROM message WHERE id = ?1",
                        rusqlite::params![end_id],
                        |row| row.get::<_, Option<i64>>(0),
                    ) {
                        comp.end_time = ts;
                    }
                }
            }
        }
    }

    Ok(compartments)
}

pub fn get_session_facts(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SessionFact>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, category, content, created_at, updated_at
         FROM session_facts WHERE session_id = ?1 ORDER BY category, created_at DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(SessionFact {
            id: row.get(0)?,
            session_id: row.get(1)?,
            category: row.get(2)?,
            content: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn get_session_notes(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<Note>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, type, status, content, session_id, project_path, surface_condition,
                created_at, updated_at, last_checked_at, ready_at, ready_reason
         FROM notes WHERE session_id = ?1 AND type = 'session' AND status = 'active'
         ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(Note {
            id: row.get(0)?,
            note_type: row.get(1)?,
            status: row.get(2)?,
            content: row.get(3)?,
            session_id: row.get(4)?,
            project_path: row.get(5)?,
            surface_condition: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
            last_checked_at: row.get(9)?,
            ready_at: row.get(10)?,
            ready_reason: row.get(11)?,
        })
    })?;
    rows.collect()
}

pub fn update_session_fact(
    conn: &mut Connection,
    fact_id: i64,
    content: &str,
) -> Result<usize, rusqlite::Error> {
    // Phase A: read the fact's owning session before opening the transaction.
    let session_id = lookup_session_fact_session_id(conn, fact_id)?;

    // Phase B: re-check the owner, mutate, and bump session_facts_version together.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    verify_session_fact_session_unchanged(&tx, fact_id, &session_id)?;
    let affected = tx.execute(
        "UPDATE session_facts SET content = ?1, updated_at = ?2 WHERE id = ?3",
        params![content, now_millis(), fact_id],
    )?;
    if affected > 0 {
        bump_session_facts_version_for_session(&tx, &session_id)?;
    }
    tx.commit()?;
    Ok(affected)
}

pub fn delete_session_fact(conn: &mut Connection, fact_id: i64) -> Result<usize, rusqlite::Error> {
    // Phase A: read the fact's owning session before opening the transaction.
    let session_id = lookup_session_fact_session_id(conn, fact_id)?;

    // Phase B: re-check, bump before delete, then delete.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    verify_session_fact_session_unchanged(&tx, fact_id, &session_id)?;
    bump_session_facts_version_for_session(&tx, &session_id)?;
    let affected = tx.execute("DELETE FROM session_facts WHERE id = ?1", params![fact_id])?;
    tx.commit()?;
    Ok(affected)
}

pub fn update_note(
    conn: &Connection,
    note_id: i64,
    content: &str,
) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE notes SET content = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![content, chrono::Utc::now().timestamp_millis(), note_id],
    )
}

pub fn delete_note(conn: &Connection, note_id: i64) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "DELETE FROM notes WHERE id = ?1",
        rusqlite::params![note_id],
    )
}

pub fn dismiss_note(conn: &Connection, note_id: i64) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE notes SET status = 'dismissed', updated_at = ?1 WHERE id = ?2",
        rusqlite::params![chrono::Utc::now().timestamp_millis(), note_id],
    )
}

pub fn get_smart_notes(
    conn: &Connection,
    project_path: &str,
) -> Result<Vec<Note>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, type, status, content, session_id, project_path, surface_condition,
                created_at, updated_at, last_checked_at, ready_at, ready_reason
         FROM notes
         WHERE project_path = ?1 AND type = 'smart' AND status != 'dismissed'
         ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(rusqlite::params![project_path], |row| {
        Ok(Note {
            id: row.get(0)?,
            note_type: row.get(1)?,
            status: row.get(2)?,
            content: row.get(3)?,
            session_id: row.get(4)?,
            project_path: row.get(5)?,
            surface_condition: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
            last_checked_at: row.get(9)?,
            ready_at: row.get(10)?,
            ready_reason: row.get(11)?,
        })
    })?;
    rows.collect()
}

pub fn get_session_meta(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<SessionMetaRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT session_id, last_response_time, cache_ttl, counter, last_nudge_tokens,
                last_nudge_band, is_subagent, last_context_percentage, last_input_tokens,
                times_execute_threshold_reached, compartment_in_progress, system_prompt_hash,
                memory_block_count, COALESCE(new_work_tokens, 0), COALESCE(total_input_tokens, 0)
         FROM session_meta WHERE session_id = ?1",
    )?;
    let mut rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(SessionMetaRow {
            session_id: row.get(0)?,
            last_response_time: row.get(1)?,
            cache_ttl: row.get(2)?,
            counter: row.get(3)?,
            last_nudge_tokens: row.get(4)?,
            last_nudge_band: row.get::<_, String>(5)?,
            is_subagent: row.get::<_, i64>(6)? != 0,
            last_context_percentage: row.get(7)?,
            last_input_tokens: row.get(8)?,
            times_execute_threshold_reached: row.get(9)?,
            compartment_in_progress: row.get::<_, i64>(10)? != 0,
            system_prompt_hash: row.get(11)?,
            memory_block_count: row.get(12)?,
            new_work_tokens: row.get(13)?,
            total_input_tokens: row.get(14)?,
        })
    })?;
    match rows.next() {
        Some(Ok(row)) => Ok(Some(row)),
        Some(Err(e)) => Err(e),
        None => Ok(None),
    }
}

pub fn get_subagent_invocations(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SubagentInvocation>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, harness, subagent, task, provider_id, model_id,
                started_at, ended_at, status, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, error, parent_invocation_id
         FROM subagent_invocations
         WHERE session_id = ?1
         ORDER BY started_at DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(SubagentInvocation {
            id: row.get(0)?,
            session_id: row.get(1)?,
            harness: row.get(2)?,
            subagent: row.get(3)?,
            task: row.get(4)?,
            provider_id: row.get(5)?,
            model_id: row.get(6)?,
            started_at: row.get(7)?,
            ended_at: row.get(8)?,
            status: row.get(9)?,
            input_tokens: row.get(10)?,
            output_tokens: row.get(11)?,
            cache_read_tokens: row.get(12)?,
            cache_write_tokens: row.get(13)?,
            error: row.get(14)?,
            parent_invocation_id: row.get(15)?,
        })
    })?;
    rows.collect()
}

pub fn get_subagent_totals_by_subagent(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SubagentTotals>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT subagent, COUNT(*), COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cache_read_tokens), 0),
                COALESCE(SUM(cache_write_tokens), 0)
         FROM subagent_invocations
         WHERE session_id = ?1
         GROUP BY subagent
         ORDER BY subagent",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(SubagentTotals {
            subagent: row.get(0)?,
            invocations: row.get(1)?,
            total_input: row.get(2)?,
            total_output: row.get(3)?,
            total_cache_read: row.get(4)?,
            total_cache_write: row.get(5)?,
        })
    })?;
    rows.collect()
}

// ── Dreamer queries ─────────────────────────────────────────

pub fn get_dream_queue(conn: &Connection) -> Result<Vec<DreamQueueEntry>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, project_path, reason, enqueued_at, started_at, retry_count
         FROM dream_queue ORDER BY enqueued_at DESC LIMIT 50",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(DreamQueueEntry {
            id: row.get(0)?,
            project_path: row.get(1)?,
            reason: row.get(2)?,
            enqueued_at: row.get(3)?,
            started_at: row.get(4)?,
            retry_count: row.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn get_dream_state(conn: &Connection) -> Result<Vec<DreamStateEntry>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT key, value FROM dream_state")?;
    let rows = stmt.query_map([], |row| {
        Ok(DreamStateEntry {
            key: row.get(0)?,
            value: row.get(1)?,
        })
    })?;
    rows.collect()
}

fn parse_dream_run_json<T: serde::de::DeserializeOwned>(
    value: &str,
    column_index: usize,
) -> Result<T, rusqlite::Error> {
    serde_json::from_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column_index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn map_dream_run_row(row: &rusqlite::Row<'_>) -> Result<DreamRun, rusqlite::Error> {
    let tasks_json_str: String = row.get(5)?;
    let memory_changes_json_str: Option<String> = row.get(10)?;

    Ok(DreamRun {
        id: row.get(0)?,
        project_path: row.get(1)?,
        started_at: row.get(2)?,
        finished_at: row.get(3)?,
        holder_id: row.get(4)?,
        tasks_json: parse_dream_run_json(&tasks_json_str, 5)?,
        tasks_succeeded: row.get(6)?,
        tasks_failed: row.get(7)?,
        smart_notes_surfaced: row.get(8)?,
        smart_notes_pending: row.get(9)?,
        memory_changes_json: memory_changes_json_str
            .as_deref()
            .map(|value| parse_dream_run_json(value, 10))
            .transpose()?,
    })
}

fn enrich_dream_run_tokens(conn: &Connection, run: &mut DreamRun) {
    let Ok(mut tasks) = serde_json::from_value::<Vec<serde_json::Value>>(run.tasks_json.clone())
    else {
        return;
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT task, COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0),
                COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0)
         FROM subagent_invocations
         WHERE subagent = 'dreamer' AND started_at >= ?1 AND started_at <= ?2
         GROUP BY task",
    ) else {
        return;
    };
    let Ok(rows) = stmt.query_map(rusqlite::params![run.started_at, run.finished_at], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
        ))
    }) else {
        return;
    };
    let mut totals = std::collections::HashMap::new();
    for row in rows.flatten() {
        totals.insert(row.0.clone(), row);
    }
    for task in &mut tasks {
        let Some(name) = task.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        if let Some((_, total, input, output, cache_read, cache_write)) = totals.get(name) {
            if let Some(obj) = task.as_object_mut() {
                obj.insert(
                    "tokens".to_string(),
                    serde_json::json!({
                        "total": total,
                        "input": input,
                        "output": output,
                        "cache_read": cache_read,
                        "cache_write": cache_write,
                    }),
                );
            }
        }
    }
    run.tasks_json = serde_json::Value::Array(tasks);
}

#[derive(Debug, Serialize, Clone)]
pub struct DreamMemoryChange {
    pub id: i64,
    pub category: String,
    pub content: String,
    pub status: String,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct DreamRunMemoryDetail {
    pub written: Vec<DreamMemoryChange>,
    pub archived: Vec<DreamMemoryChange>,
    pub merged: Vec<DreamMemoryChange>,
}

/// Reconstruct WHICH memories a dream run changed, by time-window over the run's
/// [started_at, finished_at]. `dream_runs` stores only counts (id-set diffs at
/// run time), so this is the retroactive view for existing runs:
///   - written  = memories created in the window
///   - merged   = memories superseded (merged into a canonical) in the window
///   - archived = memories archived (non-merged) in the window that pre-existed
/// Exact for `written`; archived/merged can differ by edge cases from the stored
/// count (e.g. a memory archived then un-archived). A future schema that records
/// the actual changed ids at run time would make this exact (see note).
pub fn get_dream_run_memory_changes(
    conn: &Connection,
    run_id: i64,
) -> Result<DreamRunMemoryDetail, String> {
    let (project_path, started_at, finished_at): (String, i64, i64) = conn
        .query_row(
            "SELECT project_path, started_at, finished_at FROM dream_runs WHERE id = ?1",
            rusqlite::params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| e.to_string())?;

    let paths = resolve_paths_for_memory_filter(conn, &project_path).map_err(|e| e.to_string())?;
    if paths.is_empty() {
        return Ok(DreamRunMemoryDetail::default());
    }
    let placeholders = paths.iter().map(|_| "?").collect::<Vec<_>>().join(", ");

    // One query covers all three buckets; classify per row in Rust so the
    // window/path predicates are written once.
    let sql = format!(
        "SELECT id, category, content, status, created_at, updated_at, superseded_by_memory_id
           FROM memories
          WHERE project_path IN ({placeholders})
            AND (
                  (created_at >= ?{c1} AND created_at <= ?{c2})
               OR (updated_at >= ?{c1} AND updated_at <= ?{c2})
            )",
        c1 = paths.len() + 1,
        c2 = paths.len() + 2,
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut params: Vec<&dyn rusqlite::ToSql> = paths
        .iter()
        .map(|p| p as &dyn rusqlite::ToSql)
        .collect();
    params.push(&started_at);
    params.push(&finished_at);

    let mut detail = DreamRunMemoryDetail::default();
    let mut rows = stmt
        .query(params.as_slice())
        .map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id: i64 = row.get(0).map_err(|e| e.to_string())?;
        let category: String = row.get(1).map_err(|e| e.to_string())?;
        let content: String = row.get(2).map_err(|e| e.to_string())?;
        let status: String = row.get(3).map_err(|e| e.to_string())?;
        let created_at: i64 = row.get(4).map_err(|e| e.to_string())?;
        let updated_at: i64 = row.get(5).map_err(|e| e.to_string())?;
        let superseded: Option<i64> = row.get(6).map_err(|e| e.to_string())?;
        let change = DreamMemoryChange {
            id,
            category,
            content,
            status,
        };
        let created_in_window = created_at >= started_at && created_at <= finished_at;
        let updated_in_window = updated_at >= started_at && updated_at <= finished_at;
        if created_in_window {
            detail.written.push(change);
        } else if superseded.is_some() && updated_in_window {
            detail.merged.push(change);
        } else if change.status == "archived" && updated_in_window {
            detail.archived.push(change);
        }
    }
    Ok(detail)
}

pub fn get_dream_runs(
    conn: &Connection,
    project_path: Option<&str>,
    limit: usize,
) -> Result<Vec<DreamRun>, String> {
    let normalized_limit = std::cmp::max(limit, 1) as i64;
    let mut runs: Vec<DreamRun> = Vec::new();

    if let Some(project_path) = project_path {
        let mut stmt = conn
            .prepare(
                "SELECT id, project_path, started_at, finished_at, holder_id, tasks_json, tasks_succeeded, tasks_failed, smart_notes_surfaced, smart_notes_pending, memory_changes_json
                 FROM dream_runs
                 WHERE project_path = ?1
                 ORDER BY finished_at DESC
                 LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params![project_path, normalized_limit])
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mapped = map_dream_run_row(row).map_err(|e| e.to_string())?;
            runs.push(mapped);
        }
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT id, project_path, started_at, finished_at, holder_id, tasks_json, tasks_succeeded, tasks_failed, smart_notes_surfaced, smart_notes_pending, memory_changes_json
                 FROM dream_runs
                 ORDER BY finished_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params![normalized_limit])
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mapped = map_dream_run_row(row).map_err(|e| e.to_string())?;
            runs.push(mapped);
        }
    }

    for run in &mut runs {
        enrich_dream_run_tokens(conn, run);
    }
    Ok(runs)
}

pub fn enqueue_dream(
    conn: &Connection,
    project_path: &str,
    reason: &str,
) -> Result<i64, rusqlite::Error> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO dream_queue (project_path, reason, enqueued_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![project_path, reason, now],
    )?;
    Ok(conn.last_insert_rowid())
}

// ── User Memory types ───────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct UserMemory {
    pub id: i64,
    pub content: String,
    pub status: String,
    pub promoted_at: Option<i64>,
    pub source_candidate_ids: Option<serde_json::Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct UserMemoryCandidate {
    pub id: i64,
    pub content: String,
    pub session_id: String,
    pub source_compartment_start: Option<i64>,
    pub source_compartment_end: Option<i64>,
    pub created_at: i64,
}

// ── User Memory queries ──────────────────────────────────────

pub fn get_user_memories(
    conn: &Connection,
    status_filter: Option<&str>,
) -> Result<Vec<UserMemory>, rusqlite::Error> {
    let mut conditions = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(s) = status_filter {
        params.push(Box::new(s.to_string()));
        conditions.push(format!("status = ?{}", params.len()));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let sql = format!(
        "SELECT id, content, status, promoted_at, source_candidate_ids, created_at, updated_at
         FROM user_memories
         {}
         ORDER BY created_at DESC",
        where_clause
    );

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |row| {
        let source_candidate_ids: Option<String> = row.get(4)?;
        Ok(UserMemory {
            id: row.get(0)?,
            content: row.get(1)?,
            status: row.get(2)?,
            promoted_at: row.get(3)?,
            source_candidate_ids: source_candidate_ids
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok()),
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn get_user_memory_candidates(
    conn: &Connection,
) -> Result<Vec<UserMemoryCandidate>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, content, session_id, source_compartment_start, source_compartment_end, created_at
         FROM user_memory_candidates
         ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(UserMemoryCandidate {
            id: row.get(0)?,
            content: row.get(1)?,
            session_id: row.get(2)?,
            source_compartment_start: row.get(3)?,
            source_compartment_end: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn dismiss_user_memory(conn: &mut Connection, id: i64) -> Result<(), rusqlite::Error> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let affected = tx.execute(
        "UPDATE user_memories SET status = 'dismissed', updated_at = ?1 WHERE id = ?2",
        params![now_millis(), id],
    )?;
    if affected > 0 {
        bump_project_user_profile_version(&tx)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_user_memory(conn: &mut Connection, id: i64) -> Result<(), rusqlite::Error> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let affected = tx.execute("DELETE FROM user_memories WHERE id = ?1", params![id])?;
    if affected > 0 {
        bump_project_user_profile_version(&tx)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_user_memory_candidate(conn: &Connection, id: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM user_memory_candidates WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn promote_user_memory_candidate(
    conn: &mut Connection,
    id: i64,
) -> Result<(), rusqlite::Error> {
    let now = now_millis();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let content: String = tx.query_row(
        "SELECT content FROM user_memory_candidates WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )?;

    tx.execute(
        "INSERT INTO user_memories
           (content, status, promoted_at, source_candidate_ids, created_at, updated_at)
         VALUES (?1, 'active', ?2, ?3, ?2, ?2)",
        params![content, now, format!("[{id}]")],
    )?;
    tx.execute(
        "DELETE FROM user_memory_candidates WHERE id = ?1",
        params![id],
    )?;
    bump_project_user_profile_version(&tx)?;

    tx.commit()?;
    Ok(())
}

// ── Database health ───────────────────────────────────────

pub fn get_db_health(db_path: &PathBuf) -> DbHealth {
    let exists = db_path.exists();
    let size_bytes: u64 = if exists {
        std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    let wal_path = db_path.with_extension("db-wal");
    let wal_size_bytes: u64 = if wal_path.exists() {
        std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    let mut table_counts = Vec::new();
    if exists {
        if let Ok(conn) = open_readonly(db_path) {
            let tables = [
                "memories",
                "compartments",
                "session_facts",
                "notes",
                "session_meta",
                "tags",
                "pending_ops",
                "dream_queue",
                "dream_state",
            ];
            for table in &tables {
                let count: i64 = conn
                    .query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0))
                    .unwrap_or(0);
                table_counts.push(TableCount {
                    table_name: table.to_string(),
                    row_count: count,
                });
            }
        }
    }

    DbHealth {
        exists,
        path: db_path.to_string_lossy().to_string(),
        size_bytes,
        wal_size_bytes,
        table_counts,
    }
}

#[cfg(test)]
mod session_history_slice_tests {
    use super::extract_session_history_slice;

    #[test]
    fn extracts_inclusive_block() {
        let m0 = "<project-docs>x</project-docs>\n<session-history>\n<compartment>hi</compartment>\n</session-history>\n<user-profile>y</user-profile>";
        let slice = extract_session_history_slice(m0).expect("slice present");
        assert!(slice.starts_with("<session-history>"));
        assert!(slice.ends_with("</session-history>"));
        assert!(slice.contains("<compartment>hi</compartment>"));
        // Must NOT bleed into neighboring blocks.
        assert!(!slice.contains("project-docs"));
        assert!(!slice.contains("user-profile"));
    }

    #[test]
    fn returns_none_when_absent() {
        // Pre-materialization snapshot or a snapshot without compartments.
        assert!(extract_session_history_slice("<project-docs>only</project-docs>").is_none());
        assert!(extract_session_history_slice("").is_none());
    }

    #[test]
    fn returns_none_on_unclosed_block() {
        // Defensive: an open tag with no close must not panic or over-read.
        assert!(extract_session_history_slice("<session-history>oops no close").is_none());
    }
}

#[cfg(test)]
mod list_sessions_paged_tests {
    use super::*;

    fn make_rows(count: usize) -> Vec<SessionRow> {
        (0..count)
            .map(|idx| SessionRow {
                harness: if idx % 2 == 0 {
                    Harness::Opencode
                } else {
                    Harness::Pi
                },
                session_id: format!("session-{idx:02}"),
                title: format!("Session {idx}"),
                project_identity: if idx % 3 == 0 {
                    "project-a"
                } else {
                    "project-b"
                }
                .to_string(),
                project_display: "Project".to_string(),
                last_activity_ms: (1000 - idx) as i64,
                is_subagent: idx % 4 == 0,
            })
            .collect()
    }

    #[test]
    fn paging_unset_returns_full_list_like_list_all_sessions() {
        let rows = make_rows(12);
        let paged = page_session_rows(rows.clone(), None, None);

        assert_eq!(paged.total, rows.len() as u32);
        assert!(!paged.has_more);
        assert_eq!(
            paged
                .rows
                .iter()
                .map(|row| row.session_id.as_str())
                .collect::<Vec<_>>(),
            rows.iter()
                .map(|row| row.session_id.as_str())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn paging_slices_rows_and_reports_has_more() {
        let rows = make_rows(12);
        let first = page_session_rows(rows.clone(), Some(0), Some(5));
        let second = page_session_rows(rows.clone(), Some(5), Some(5));
        let past_end = page_session_rows(rows, Some(20), Some(5));

        assert_eq!(first.rows.len(), 5);
        assert_eq!(first.rows[0].session_id, "session-00");
        assert!(first.has_more);
        assert_eq!(second.rows.len(), 5);
        assert_eq!(second.rows[0].session_id, "session-05");
        assert!(second.has_more);
        assert!(past_end.rows.is_empty());
        assert!(!past_end.has_more);
    }

    #[test]
    fn total_reflects_filtered_rows_before_paging() {
        let filter = SessionFilter {
            project_identity: Some("project-a".to_string()),
            ..SessionFilter::default()
        };
        let filtered: Vec<SessionRow> = make_rows(12)
            .into_iter()
            .filter(|row| session_matches_filter(row, &filter))
            .collect();
        let paged = page_session_rows(filtered, Some(0), Some(2));

        assert_eq!(paged.total, 4);
        assert_eq!(paged.rows.len(), 2);
        assert!(paged.has_more);
    }
}

#[cfg(test)]
mod clean_pi_title_tests {
    use super::clean_pi_title;

    #[test]
    fn explicit_session_name_wins() {
        assert_eq!(
            clean_pi_title(Some("My Session".into()), "anything"),
            "My Session"
        );
    }

    #[test]
    fn empty_session_name_is_ignored() {
        assert_eq!(clean_pi_title(Some("   ".into()), "fallback"), "fallback");
    }

    #[test]
    fn first_message_is_returned_when_no_banner() {
        assert_eq!(
            clean_pi_title(None, "implementing the new feature"),
            "implementing the new feature"
        );
    }

    #[test]
    fn migration_banner_is_stripped() {
        let banner = "<!-- migrated from OpenCode session ses_abc at 2026-05-01T16:48:44.508Z --> The following conversation was migrated from a different harness. Reasoning context from prior turns may be incomplete; tool calls reference tools that may not exist in this environment.";
        assert_eq!(clean_pi_title(None, banner), "Migrated session");
    }

    #[test]
    fn migration_banner_with_trailing_text_uses_trailing_text() {
        let banner = "<!-- migrated from OpenCode session ses_abc at 2026-05-01T16:48:44.508Z --> The following conversation was migrated from a different harness. Reasoning context from prior turns may be incomplete; tool calls reference tools that may not exist in this environment. Plan compaction-marker rollout";
        assert_eq!(
            clean_pi_title(None, banner),
            "Plan compaction-marker rollout"
        );
    }

    #[test]
    fn unknown_html_comment_is_passed_through_after_strip() {
        let text = "<!-- some other note --> real intent";
        assert_eq!(clean_pi_title(None, text), "real intent");
    }
}

#[cfg(test)]
mod load_messages_tests {
    use super::*;
    use rusqlite::Connection;

    /// Build a minimal in-memory OpenCode-shaped DB so we can exercise
    /// `load_opencode_messages` against the same schema OpenCode uses.
    fn make_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );",
        )
        .expect("create schema");
        conn
    }

    fn insert_message(conn: &Connection, id: &str, role: &str, time: i64) {
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, 'ses_test', ?2, ?3)",
            (id, time, format!(r#"{{"role":"{}","time":{{"created":{}}}}}"#, role, time)),
        )
        .expect("insert message");
    }

    fn insert_part(conn: &Connection, id: &str, message_id: &str, time: i64, data: &str) {
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
             VALUES (?1, ?2, 'ses_test', ?3, ?3, ?4)",
            (id, message_id, time, data),
        )
        .expect("insert part");
    }

    #[test]
    fn aggregates_text_parts_into_preview() {
        let conn = make_test_db();
        insert_message(&conn, "msg_user_1", "user", 100);
        insert_part(
            &conn,
            "prt_1",
            "msg_user_1",
            100,
            r#"{"type":"text","text":"hello world"}"#,
        );

        let messages = load_opencode_messages(&conn, "ses_test").expect("load");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text_preview, "hello world");
    }

    #[test]
    fn concatenates_multiple_text_parts() {
        let conn = make_test_db();
        insert_message(&conn, "msg_assistant_1", "assistant", 200);
        insert_part(
            &conn,
            "prt_a",
            "msg_assistant_1",
            200,
            r#"{"type":"text","text":"first chunk"}"#,
        );
        insert_part(
            &conn,
            "prt_b",
            "msg_assistant_1",
            201,
            r#"{"type":"text","text":"second chunk"}"#,
        );

        let messages = load_opencode_messages(&conn, "ses_test").expect("load");
        assert_eq!(messages.len(), 1);
        // GROUP_CONCAT does not guarantee order across SQLite versions; both
        // halves must be present and joined by the configured separator.
        assert!(
            messages[0].text_preview.contains("first chunk"),
            "preview missing first chunk: {:?}",
            messages[0].text_preview
        );
        assert!(
            messages[0].text_preview.contains("second chunk"),
            "preview missing second chunk: {:?}",
            messages[0].text_preview
        );
    }

    #[test]
    fn skips_non_text_parts() {
        let conn = make_test_db();
        insert_message(&conn, "msg_assistant_2", "assistant", 300);
        insert_part(
            &conn,
            "prt_tool",
            "msg_assistant_2",
            300,
            r#"{"type":"tool","callID":"x","tool":"read"}"#,
        );
        insert_part(
            &conn,
            "prt_step",
            "msg_assistant_2",
            301,
            r#"{"type":"step-finish","reason":"tool-calls"}"#,
        );
        insert_part(
            &conn,
            "prt_reasoning",
            "msg_assistant_2",
            302,
            r#"{"type":"reasoning","text":"internal thinking"}"#,
        );
        insert_part(
            &conn,
            "prt_text",
            "msg_assistant_2",
            303,
            r#"{"type":"text","text":"public answer"}"#,
        );

        let messages = load_opencode_messages(&conn, "ses_test").expect("load");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text_preview, "public answer");
        assert!(!messages[0].text_preview.contains("internal thinking"));
        assert!(!messages[0].text_preview.contains("read"));
    }

    #[test]
    fn empty_preview_when_no_text_parts() {
        let conn = make_test_db();
        insert_message(&conn, "msg_tool_only", "assistant", 400);
        insert_part(
            &conn,
            "prt_tool_only",
            "msg_tool_only",
            400,
            r#"{"type":"tool","callID":"x","tool":"read"}"#,
        );

        let messages = load_opencode_messages(&conn, "ses_test").expect("load");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text_preview, "");
    }

    #[test]
    fn orders_messages_by_time_created() {
        let conn = make_test_db();
        insert_message(&conn, "msg_late", "user", 1000);
        insert_message(&conn, "msg_early", "user", 100);
        insert_part(
            &conn,
            "prt_late",
            "msg_late",
            1000,
            r#"{"type":"text","text":"late"}"#,
        );
        insert_part(
            &conn,
            "prt_early",
            "msg_early",
            100,
            r#"{"type":"text","text":"early"}"#,
        );

        let messages = load_opencode_messages(&conn, "ses_test").expect("load");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].text_preview, "early");
        assert_eq!(messages[1].text_preview, "late");
    }

    #[test]
    fn normalizes_whitespace_and_truncates_to_500_chars() {
        let conn = make_test_db();
        let long_text = "x".repeat(700);
        insert_message(&conn, "msg_long", "user", 100);
        insert_part(
            &conn,
            "prt_long",
            "msg_long",
            100,
            &format!(r#"{{"type":"text","text":"{}"}}"#, long_text),
        );

        let messages = load_opencode_messages(&conn, "ses_test").expect("load");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text_preview.chars().count(), 500);
    }

    #[test]
    fn ignores_parts_belonging_to_other_messages() {
        let conn = make_test_db();
        insert_message(&conn, "msg_a", "user", 100);
        insert_message(&conn, "msg_b", "user", 200);
        insert_part(
            &conn,
            "prt_a",
            "msg_a",
            100,
            r#"{"type":"text","text":"text for a"}"#,
        );
        insert_part(
            &conn,
            "prt_b",
            "msg_b",
            200,
            r#"{"type":"text","text":"text for b"}"#,
        );

        let messages = load_opencode_messages(&conn, "ses_test").expect("load");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].text_preview, "text for a");
        assert_eq!(messages[1].text_preview, "text for b");
    }
}

#[cfg(test)]
mod cache_turn_tests {
    use super::*;

    fn raw(
        harness: Harness,
        message_id: &str,
        session_id: &str,
        timestamp: i64,
        input: i64,
        cache_read: i64,
        cache_write: i64,
        total: i64,
        finish: Option<&str>,
    ) -> RawDbCacheEvent {
        RawDbCacheEvent {
            harness,
            message_id: message_id.to_string(),
            session_id: session_id.to_string(),
            timestamp,
            input_tokens: input,
            cache_read,
            cache_write,
            total_tokens: total,
            agent: None,
            finish: finish.map(|s| s.to_string()),
        }
    }

    #[test]
    fn first_event_is_new_turn() {
        let rows = vec![raw(
            Harness::Opencode,
            "m1",
            "s1",
            100,
            10,
            80,
            10,
            100,
            Some("stop"),
        )];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events.len(), 1);
        assert!(events[0].is_turn_start);
        assert_eq!(events[0].turn_id, "m1");
    }

    #[test]
    fn tool_calls_continuation_same_turn() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                10,
                80,
                10,
                100,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                10,
                85,
                5,
                100,
                Some("stop"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events.len(), 2);
        assert!(events[0].is_turn_start);
        assert!(!events[1].is_turn_start);
        assert_eq!(events[0].turn_id, "m1");
        assert_eq!(events[1].turn_id, "m1");
    }

    #[test]
    fn stop_then_new_turn() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                10,
                80,
                10,
                100,
                Some("stop"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                10,
                80,
                10,
                100,
                Some("stop"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events.len(), 2);
        assert!(events[0].is_turn_start);
        assert!(events[1].is_turn_start);
        assert_eq!(events[0].turn_id, "m1");
        assert_eq!(events[1].turn_id, "m2");
    }

    #[test]
    fn end_turn_acts_like_stop() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                10,
                80,
                10,
                100,
                Some("end_turn"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                10,
                80,
                10,
                100,
                Some("tool-calls"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert!(events[0].is_turn_start);
        assert!(events[1].is_turn_start);
    }

    #[test]
    fn interleaved_sessions_keep_per_session_turns() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "a1",
                "s1",
                100,
                10,
                80,
                10,
                100,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "b1",
                "s2",
                101,
                10,
                80,
                10,
                100,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "a2",
                "s1",
                200,
                10,
                85,
                5,
                100,
                Some("stop"),
            ),
            raw(
                Harness::Opencode,
                "b2",
                "s2",
                201,
                10,
                85,
                5,
                100,
                Some("stop"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events[0].turn_id, "a1");
        assert_eq!(events[1].turn_id, "b1");
        assert_eq!(events[2].turn_id, "a1");
        assert_eq!(events[3].turn_id, "b1");
    }

    #[test]
    fn warming_downgrades_continuation_with_degraded_cache() {
        // First event: cache_read=120, cache_write=20 → expected next prefix ~140.
        //   total_prompt = input(10)+read(120)+write(20)=150; hit_ratio=0.80 → "warning".
        //   But this is a TURN START so warming downgrade does not apply.
        //   We accept "warning" here — the point of THIS test is the second event.
        // Second event: cache_read=50 (< 0.9 * 140 = 126) and hit_ratio < 0.5 → bust → warming
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                10,
                120,
                20,
                150,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                10,
                50,
                90,
                150,
                Some("stop"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        // events[0] is the turn-start; severity stays whatever the absolute hit_ratio classifies it as.
        // events[1] is the continuation with degraded cache_read → downgraded from bust/warning to warming.
        assert_eq!(events[1].severity, "warming");
    }

    #[test]
    fn warming_does_not_downgrade_stable() {
        // Continuation with good cache_read stays stable.
        // m1: total_prompt=10+135+5=150, hit_ratio=0.90 → "stable".
        // m2: cache_read=140 ≥ 0.9*(135+5)=126, total_prompt=10+140+5=155, hit_ratio≈0.903 → "stable".
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                10,
                135,
                5,
                150,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                10,
                140,
                5,
                155,
                Some("stop"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events[0].severity, "stable");
        assert_eq!(events[1].severity, "stable");
    }

    #[test]
    fn pi_stop_reason_extracted_as_finish() {
        // build_db_cache_events is harness-agnostic for grouping;
        // just verify Pi rows with stop_reason are processed correctly.
        let rows = vec![
            raw(
                Harness::Pi,
                "p1",
                "s1",
                100,
                10,
                80,
                10,
                100,
                Some("tool-calls"),
            ),
            raw(Harness::Pi, "p2", "s1", 200, 10, 80, 10, 100, Some("stop")),
        ];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events.len(), 2);
        assert!(events[0].is_turn_start);
        assert!(!events[1].is_turn_start);
        assert_eq!(events[1].turn_id, "p1");
    }
}

#[cfg(test)]
mod get_session_cache_events_by_turn_count_tests {
    use super::*;

    fn event(
        message_id: &str,
        session_id: &str,
        timestamp: i64,
        is_turn_start: bool,
    ) -> DbCacheEvent {
        DbCacheEvent {
            harness: Harness::Opencode,
            message_id: message_id.to_string(),
            session_id: session_id.to_string(),
            timestamp,
            input_tokens: 10,
            cache_read: 80,
            cache_write: 10,
            total_tokens: 100,
            hit_ratio: 0.8,
            severity: "stable".to_string(),
            cause: None,
            agent: None,
            finish: Some("stop".to_string()),
            turn_id: String::new(),
            is_turn_start,
        }
    }

    #[test]
    fn empty_session_returns_empty() {
        let result = trim_events_to_turns(Vec::new(), 3);
        assert!(result.is_empty());
    }

    #[test]
    fn fewer_turns_than_target_returns_all() {
        // 2 turns, target=10 → all events returned
        let events = vec![
            event("m1", "s1", 100, true),
            event("m2", "s1", 200, false),
            event("m3", "s1", 300, true),
            event("m4", "s1", 400, false),
        ];
        let result = trim_events_to_turns(events.clone(), 10);
        assert_eq!(result.len(), 4);
        assert_eq!(result[0].message_id, "m1");
        assert_eq!(result[3].message_id, "m4");
    }

    #[test]
    fn trims_oldest_turns_when_over_target() {
        // 5 turns, target=3 → keep last 3 turns (turns 3-5 = m5-m12)
        let events = vec![
            event("m1", "s1", 100, true),    // turn 1 start
            event("m2", "s1", 200, false),   // turn 1 cont
            event("m3", "s1", 300, true),    // turn 2 start
            event("m4", "s1", 400, false),   // turn 2 cont
            event("m5", "s1", 500, true),    // turn 3 start
            event("m6", "s1", 600, false),   // turn 3 cont
            event("m7", "s1", 700, true),    // turn 4 start
            event("m8", "s1", 800, false),   // turn 4 cont
            event("m9", "s1", 900, true),    // turn 5 start
            event("m10", "s1", 1000, false), // turn 5 cont
            event("m11", "s1", 1100, false), // turn 5 cont
            event("m12", "s1", 1200, false), // turn 5 cont
        ];
        let result = trim_events_to_turns(events, 3);
        assert_eq!(result.len(), 8); // m5-m12
        assert_eq!(result[0].message_id, "m5");
        assert_eq!(result[7].message_id, "m12");
        // Verify turn starts in the trimmed result
        assert!(result[0].is_turn_start); // m5 (turn 3 start)
        assert!(!result[1].is_turn_start); // m6
        assert!(result[2].is_turn_start); // m7 (turn 4 start)
        assert!(!result[3].is_turn_start); // m8
        assert!(result[4].is_turn_start); // m9 (turn 5 start)
    }

    #[test]
    fn exact_target_turns_returns_all() {
        // 3 turns, target=3 → all events returned
        let events = vec![
            event("m1", "s1", 100, true),
            event("m2", "s1", 200, false),
            event("m3", "s1", 300, true),
            event("m4", "s1", 400, false),
            event("m5", "s1", 500, true),
            event("m6", "s1", 600, false),
        ];
        let result = trim_events_to_turns(events.clone(), 3);
        assert_eq!(result.len(), 6);
    }

    #[test]
    fn one_long_turn_returns_all() {
        // 50 events all in one turn, target=5 → all 50 returned as one turn
        let events: Vec<DbCacheEvent> = (0..50)
            .map(|i| event(&format!("m{i}"), "s1", 100 + i as i64 * 10, i == 0))
            .collect();
        let result = trim_events_to_turns(events.clone(), 5);
        assert_eq!(result.len(), 50);
        // Only the first event should be a turn start
        assert!(result[0].is_turn_start);
        for e in result.iter().skip(1) {
            assert!(!e.is_turn_start);
        }
    }

    #[test]
    fn single_turn_target_one_returns_all() {
        let events = vec![
            event("m1", "s1", 100, true),
            event("m2", "s1", 200, false),
            event("m3", "s1", 300, false),
        ];
        let result = trim_events_to_turns(events.clone(), 1);
        assert_eq!(result.len(), 3);
        assert!(result[0].is_turn_start);
    }

    #[test]
    fn target_zero_returns_empty() {
        let events = vec![event("m1", "s1", 100, true), event("m2", "s1", 200, false)];
        let result = trim_events_to_turns(events, 0);
        assert!(result.is_empty());
    }
}

#[cfg(test)]
mod memory_project_filter_tests {
    //! Issue #87: the dashboard Memories tab project filter returned zero
    //! results when any project was selected because the frontend sent the
    //! resolved project *identity* (`git:<hash>` / `dir:<md5-12>`) while
    //! `get_memories` / `get_memory_stats` filtered with `project_path = ?`
    //! against raw filesystem paths stored in the `memories` table.
    //!
    //! These tests cover the helper that maps identities back to the set of
    //! concrete paths (handling clones + worktrees that share an identity
    //! but contribute memories under different absolute paths), and the
    //! end-to-end identity-filter behavior of `get_memories` and
    //! `get_memory_stats`.
    use super::*;
    use crate::project_identity::clear_cache_for_tests;
    use rusqlite::Connection;

    /// Build a minimal in-memory Magic Context-shaped DB with just enough of
    /// the `memories` + `memory_embeddings` + `memories_fts` surface that
    /// `get_memories` and `get_memory_stats` can run end-to-end.
    fn make_memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_path TEXT NOT NULL,
                category TEXT NOT NULL,
                content TEXT NOT NULL,
                normalized_hash TEXT,
                source_session_id TEXT,
                source_type TEXT,
                seen_count INTEGER DEFAULT 1,
                retrieval_count INTEGER DEFAULT 0,
                first_seen_at INTEGER,
                created_at INTEGER,
                updated_at INTEGER,
                last_seen_at INTEGER,
                last_retrieved_at INTEGER,
                status TEXT NOT NULL DEFAULT 'active',
                expires_at INTEGER,
                verification_status TEXT,
                verified_at INTEGER,
                superseded_by_memory_id INTEGER,
                merged_from TEXT,
                metadata_json TEXT
            );
            CREATE TABLE memory_embeddings (
                memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
                vector BLOB NOT NULL,
                model_id TEXT
            );
            CREATE VIRTUAL TABLE memories_fts USING fts5(
                content, category, content='memories', content_rowid='id'
            );",
        )
        .expect("create memory schema");
        conn
    }

    fn insert_memory(conn: &Connection, project_path: &str, category: &str, status: &str) -> i64 {
        // `map_memory_row` expects every non-Option Memory field to be
        // present and well-typed, so the test inserts must populate them:
        // normalized_hash, source_type, seen_count, retrieval_count,
        // first_seen_at, last_seen_at, verification_status. Nullable
        // columns (source_session_id, expires_at, etc.) are intentionally
        // left default-NULL.
        let content = format!("memory in {project_path} / {category}");
        let normalized_hash = format!(
            "{:x}",
            md5::compute(format!("{project_path}|{category}|{content}").as_bytes())
        );
        conn.execute(
            "INSERT INTO memories
                (project_path, category, content, normalized_hash,
                 source_type, seen_count, retrieval_count,
                 first_seen_at, last_seen_at, verification_status,
                 status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4,
                     'historian', 1, 0,
                     1000, 1000, 'unverified',
                     ?5, 1000, 1000)",
            (project_path, category, content, normalized_hash, status),
        )
        .expect("insert memory");
        conn.last_insert_rowid()
    }

    /// A non-git temp dir resolves to a `dir:<md5-12>` identity that's
    /// derived purely from the canonicalized path string — no shell-out, no
    /// git lookup. We use a stable dir so test order doesn't bite us when
    /// shared filesystem state changes.
    fn stable_dir_identity(path: &str) -> String {
        // Force the identity cache into a known state so this test doesn't
        // see leftovers from a sibling test that resolved the same path.
        clear_cache_for_tests();
        resolve_project_identity(path)
    }

    #[test]
    fn resolve_paths_returns_all_paths_sharing_identity() {
        // The CRITICAL invariant for issue #87: two clones of the same repo
        // (or two paths that resolve to the same identity for any reason)
        // both contribute memories under their own raw `project_path`, and
        // a single identity filter must surface BOTH paths' memories.
        //
        // We use the SAME path twice to guarantee they share an identity
        // without needing a real git repo in the test sandbox.
        let conn = make_memory_db();

        // Two distinct memories under the same project_path (the realistic
        // case where one path accumulates many memories over time).
        insert_memory(
            &conn,
            "/tmp/test-proj-1",
            "ARCHITECTURE_DECISIONS",
            "active",
        );
        insert_memory(&conn, "/tmp/test-proj-1", "CONSTRAINTS", "active");

        // A memory under a different path that must NOT be returned when we
        // filter by the first path's identity.
        insert_memory(
            &conn,
            "/tmp/test-proj-2",
            "ARCHITECTURE_DECISIONS",
            "active",
        );

        let identity = stable_dir_identity("/tmp/test-proj-1");
        let paths = resolve_paths_for_memory_filter(&conn, &identity).expect("resolve paths");

        assert_eq!(
            paths,
            vec!["/tmp/test-proj-1".to_string()],
            "expected exactly the matching project_path, got {paths:?}"
        );
    }

    #[test]
    fn resolve_paths_falls_back_to_raw_value_when_no_match() {
        // Backward compatibility: older dashboard builds (or external
        // callers) might send a raw path. If no stored memories resolve to
        // it as an identity, we fall back to filtering by that single value
        // — matching pre-fix behavior so legacy clients still work.
        let conn = make_memory_db();
        insert_memory(&conn, "/tmp/somewhere", "X", "active");

        let paths = resolve_paths_for_memory_filter(&conn, "/tmp/legacy-raw-path-filter")
            .expect("resolve paths");

        assert_eq!(paths, vec!["/tmp/legacy-raw-path-filter".to_string()]);
    }

    #[test]
    fn resolve_paths_empty_db_returns_filter_as_fallback() {
        // Empty memories table: no stored rows can resolve. We still return
        // the filter value so the resulting query produces an empty result
        // set deterministically instead of erroring.
        let conn = make_memory_db();
        let paths = resolve_paths_for_memory_filter(&conn, "git:abc123").expect("resolve paths");
        assert_eq!(paths, vec!["git:abc123".to_string()]);
    }

    #[test]
    fn build_in_placeholders_renders_correct_indices() {
        // Sanity check the helper used to inject IN clauses into queries
        // that mix path params with status/category/limit/offset params.
        assert_eq!(build_in_placeholders(0, 1), "");
        assert_eq!(build_in_placeholders(1, 1), "?1");
        assert_eq!(build_in_placeholders(3, 1), "?1, ?2, ?3");
        assert_eq!(build_in_placeholders(2, 5), "?5, ?6");
    }

    #[test]
    fn get_memories_with_identity_filter_returns_matching_rows() {
        // End-to-end: send a `git:`/`dir:`-style identity to get_memories
        // and verify rows are returned. Pre-fix this returned zero.
        let conn = make_memory_db();
        insert_memory(&conn, "/tmp/issue87-a", "ARCHITECTURE_DECISIONS", "active");
        insert_memory(&conn, "/tmp/issue87-a", "CONSTRAINTS", "active");
        insert_memory(&conn, "/tmp/issue87-b", "ARCHITECTURE_DECISIONS", "active");

        let identity = stable_dir_identity("/tmp/issue87-a");
        let rows =
            get_memories(&conn, Some(&identity), None, None, None, 100, 0).expect("get_memories");

        assert_eq!(rows.len(), 2, "expected both memories under /tmp/issue87-a");
        for row in &rows {
            assert_eq!(row.project_path, "/tmp/issue87-a");
        }
    }

    #[test]
    fn get_memory_stats_with_identity_filter_returns_matching_counts() {
        // End-to-end: stats must also resolve identity → paths. Pre-fix the
        // total/active/permanent/archived/categories counts were all zero
        // whenever a project was selected from the frontend dropdown.
        let conn = make_memory_db();
        insert_memory(
            &conn,
            "/tmp/issue87-stats",
            "ARCHITECTURE_DECISIONS",
            "active",
        );
        insert_memory(&conn, "/tmp/issue87-stats", "CONSTRAINTS", "active");
        insert_memory(&conn, "/tmp/issue87-stats", "USER_DIRECTIVES", "archived");
        insert_memory(
            &conn,
            "/tmp/issue87-other",
            "ARCHITECTURE_DECISIONS",
            "active",
        );

        let identity = stable_dir_identity("/tmp/issue87-stats");
        let stats = get_memory_stats(&conn, Some(&identity)).expect("get_memory_stats");

        assert_eq!(stats.total, 3);
        assert_eq!(stats.active, 2);
        assert_eq!(stats.archived, 1);
        assert_eq!(stats.permanent, 0);
        // Categories should list both active categories (archived excluded).
        let cat_names: Vec<&str> = stats
            .categories
            .iter()
            .map(|c| c.category.as_str())
            .collect();
        assert!(cat_names.contains(&"ARCHITECTURE_DECISIONS"));
        assert!(cat_names.contains(&"CONSTRAINTS"));
        assert!(!cat_names.contains(&"USER_DIRECTIVES")); // archived
    }

    #[test]
    fn get_memories_without_filter_returns_all() {
        // No regression for the unfiltered path.
        let conn = make_memory_db();
        insert_memory(&conn, "/tmp/a", "X", "active");
        insert_memory(&conn, "/tmp/b", "Y", "active");

        let rows = get_memories(&conn, None, None, None, None, 100, 0).expect("get_memories");
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn get_memory_stats_without_filter_counts_everything() {
        let conn = make_memory_db();
        insert_memory(&conn, "/tmp/a", "X", "active");
        insert_memory(&conn, "/tmp/b", "Y", "permanent");
        insert_memory(&conn, "/tmp/c", "Z", "archived");

        let stats = get_memory_stats(&conn, None).expect("get_memory_stats");
        assert_eq!(stats.total, 3);
        assert_eq!(stats.active, 1);
        assert_eq!(stats.permanent, 1);
        assert_eq!(stats.archived, 1);
    }

    /// Regression: `enumerate_memory_projects` returned rows whose
    /// `display_name` was the raw identity (e.g. `git:abc…`, `dir:abc…`)
    /// because it passed memory `project_path` values as a paths filter into
    /// `enumerate_projects_filtered`. When the plugin started stamping
    /// identities directly into memories.project_path (post-issue-#87 plugin
    /// fix), those values never matched any `worktree`/`cwd` path, so the
    /// OpenCode/Pi DB enrichment step was skipped and the fallback path
    /// seeded ProjectRow with `primary_path = "git:HASH"`, then
    /// `display_name = basename("git:HASH") = "git:HASH"`.
    ///
    /// Fix: filter the full enumerated project list by identity instead of
    /// filtering by path string. These tests pin both arms:
    ///   - identity-shaped memory values map to themselves
    ///   - raw filesystem paths get resolved through `resolve_project_identity`
    /// In both cases the returned ProjectRow display_name MUST NOT start
    /// with `git:` or `dir:`. With no OpenCode/Pi DB in the test sandbox the
    /// list is empty rather than poisoned with identity-named rows; that's
    /// the correct safe failure mode.
    #[test]
    fn enumerate_memory_projects_with_identity_memories_does_not_leak_identity_as_name() {
        // Simulate the post-#87 plugin storing the resolved identity directly
        // as project_path. Pre-fix this produced ProjectRow rows with
        // `display_name = "git:abc123…"`. Post-fix the list is empty because
        // no real OpenCode/Pi DB is attached in the test sandbox — that's
        // the correct safe state; the previous behavior was an active bug.
        let conn = make_memory_db();
        insert_memory(&conn, "git:abc1234567890abcdef", "CONSTRAINTS", "active");
        insert_memory(
            &conn,
            "git:abc1234567890abcdef",
            "ARCHITECTURE_DECISIONS",
            "active",
        );
        insert_memory(
            &conn,
            "dir:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
            "USER_DIRECTIVES",
            "active",
        );

        let rows = enumerate_memory_projects(&conn).expect("enumerate");
        for row in &rows {
            assert!(
                !row.display_name.starts_with("git:") && !row.display_name.starts_with("dir:"),
                "display_name leaked identity: {} (identity={})",
                row.display_name,
                row.identity,
            );
        }
    }

    #[test]
    fn enumerate_memory_projects_with_only_archived_memories_returns_empty() {
        // `enumerate_memory_projects` filters memories by `status = 'active'`.
        // A project whose only memories are archived should not appear in the
        // picker at all. (This was already the behavior before the fix; we
        // pin it so the new identity-filtering path doesn't accidentally
        // surface archived-only projects.)
        let conn = make_memory_db();
        insert_memory(&conn, "/tmp/archived-only", "X", "archived");
        let rows = enumerate_memory_projects(&conn).expect("enumerate");
        assert!(rows.is_empty(), "archived-only project leaked: {rows:?}");
    }

    #[test]
    fn enumerate_memory_projects_empty_db_returns_empty() {
        let conn = make_memory_db();
        let rows = enumerate_memory_projects(&conn).expect("enumerate");
        assert!(
            rows.is_empty(),
            "empty db should produce empty picker, got {rows:?}"
        );
    }
}
