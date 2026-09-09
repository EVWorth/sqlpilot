use super::*;

fn entry(id: &str, sql: &str, executed_at: &str) -> HistoryEntry {
    HistoryEntry {
        id: id.to_string(),
        sql: sql.to_string(),
        connection_name: "Test".to_string(),
        database: Some("app".to_string()),
        executed_at: executed_at.to_string(),
        execution_time_ms: 12,
        row_count: 1,
        status: "success".to_string(),
        error: None,
        error_code: None,
        error_sql_state: None,
        redacted: false,
        truncated: false,
    }
}

fn store() -> HistoryStore {
    HistoryStore::in_memory().unwrap()
}

/// Add `n` entries, oldest first, one minute apart.
fn fill(store: &HistoryStore, n: usize, limit: u32) {
    for i in 0..n {
        store
            .add(
                &entry(
                    &format!("e{i}"),
                    &format!("SELECT {i}"),
                    &format!("2026-01-01T00:{:02}:00Z", i % 60),
                ),
                limit,
            )
            .unwrap();
    }
}

#[test]
fn an_entry_round_trips_every_field() {
    let s = store();
    let mut e = entry("a", "SELECT 1", "2026-01-01T00:00:00Z");
    e.status = "error".into();
    e.error = Some("Table 'app.user' doesn't exist".into());
    e.error_code = Some(1146);
    e.error_sql_state = Some("42S02".into());
    e.redacted = true;
    e.row_count = 0;
    e.execution_time_ms = 99;

    s.add(&e, 500).unwrap();

    let listed = s.list(&HistoryQuery::default()).unwrap();
    assert_eq!(listed, vec![e]);
}

#[test]
fn entries_come_back_newest_first() {
    let s = store();
    s.add(&entry("old", "SELECT 1", "2026-01-01T00:00:00Z"), 500)
        .unwrap();
    s.add(&entry("new", "SELECT 2", "2026-01-01T00:05:00Z"), 500)
        .unwrap();

    let ids: Vec<_> = s
        .list(&HistoryQuery::default())
        .unwrap()
        .into_iter()
        .map(|e| e.id)
        .collect();
    assert_eq!(ids, vec!["new", "old"]);
}

#[test]
fn two_entries_in_the_same_second_keep_insertion_order() {
    // Timestamps have second resolution, so a fast pair ties. Falling back to
    // rowid keeps the newer one on top rather than letting SQLite choose.
    let s = store();
    s.add(&entry("first", "SELECT 1", "2026-01-01T00:00:00Z"), 500)
        .unwrap();
    s.add(&entry("second", "SELECT 2", "2026-01-01T00:00:00Z"), 500)
        .unwrap();

    let ids: Vec<_> = s
        .list(&HistoryQuery::default())
        .unwrap()
        .into_iter()
        .map(|e| e.id)
        .collect();
    assert_eq!(ids, vec!["second", "first"]);
}

#[test]
fn the_limit_drops_the_oldest() {
    let s = store();
    fill(&s, 10, 3);

    let listed = s.list(&HistoryQuery::default()).unwrap();
    assert_eq!(listed.len(), 3);
    assert_eq!(listed[0].id, "e9");
    assert_eq!(s.count().unwrap(), 3);
}

#[test]
fn lowering_the_limit_trims_on_the_next_prune() {
    let s = store();
    fill(&s, 20, 500);
    assert_eq!(s.count().unwrap(), 20);

    let removed = s.prune(5).unwrap();

    assert_eq!(removed, 15);
    assert_eq!(s.count().unwrap(), 5);
}

#[test]
fn search_matches_the_sql_text() {
    let s = store();
    s.add(
        &entry("a", "SELECT * FROM orders", "2026-01-01T00:00:00Z"),
        500,
    )
    .unwrap();
    s.add(
        &entry("b", "SELECT * FROM users", "2026-01-01T00:01:00Z"),
        500,
    )
    .unwrap();

    let found = s
        .list(&HistoryQuery {
            search: Some("orders".into()),
            ..Default::default()
        })
        .unwrap();

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, "a");
}

#[test]
fn search_treats_like_wildcards_as_literal_text() {
    // Without an ESCAPE clause, searching for "100%" is `LIKE '%100%%'`, which
    // matches every row that contains 100 — and searching for "_" matches
    // everything at all.
    let s = store();
    s.add(
        &entry("pct", "SELECT '100%' AS share", "2026-01-01T00:00:00Z"),
        500,
    )
    .unwrap();
    s.add(&entry("plain", "SELECT 1005", "2026-01-01T00:01:00Z"), 500)
        .unwrap();

    let found = s
        .list(&HistoryQuery {
            search: Some("100%".into()),
            ..Default::default()
        })
        .unwrap();

    assert_eq!(found.len(), 1, "only the row literally containing 100%");
    assert_eq!(found[0].id, "pct");
}

#[test]
fn search_matches_an_underscore_literally() {
    let s = store();
    s.add(
        &entry("snake", "SELECT user_id FROM t", "2026-01-01T00:00:00Z"),
        500,
    )
    .unwrap();
    s.add(
        &entry("other", "SELECT userXid FROM t", "2026-01-01T00:01:00Z"),
        500,
    )
    .unwrap();

    let found = s
        .list(&HistoryQuery {
            search: Some("user_id".into()),
            ..Default::default()
        })
        .unwrap();

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, "snake");
}

#[test]
fn an_empty_search_is_not_a_filter() {
    let s = store();
    fill(&s, 3, 500);

    let found = s
        .list(&HistoryQuery {
            search: Some("   ".into()),
            ..Default::default()
        })
        .unwrap();

    assert_eq!(found.len(), 3);
}

#[test]
fn removing_one_leaves_the_rest() {
    let s = store();
    fill(&s, 3, 500);

    s.remove("e1").unwrap();

    let ids: Vec<_> = s
        .list(&HistoryQuery::default())
        .unwrap()
        .into_iter()
        .map(|e| e.id)
        .collect();
    assert_eq!(ids, vec!["e2", "e0"]);
}

#[test]
fn removing_an_unknown_id_is_not_an_error() {
    let s = store();
    s.remove("nope").unwrap();
}

#[test]
fn clear_empties_the_table() {
    let s = store();
    fill(&s, 5, 500);

    s.clear().unwrap();

    assert_eq!(s.count().unwrap(), 0);
    assert!(s.list(&HistoryQuery::default()).unwrap().is_empty());
}

#[test]
fn an_over_long_statement_is_cut_and_marked() {
    let s = store();
    let huge = "x".repeat(MAX_SQL_BYTES * 2);
    s.add(&entry("big", &huge, "2026-01-01T00:00:00Z"), 500)
        .unwrap();

    let [stored] = &s.list(&HistoryQuery::default()).unwrap()[..] else {
        panic!("expected one entry");
    };
    assert!(stored.truncated);
    assert!(stored.sql.len() < huge.len());
    assert!(stored.sql.ends_with(TRUNCATION_MARKER));
}

#[test]
fn a_statement_at_the_limit_is_kept_whole() {
    let s = store();
    let exact = "x".repeat(MAX_SQL_BYTES);
    s.add(&entry("edge", &exact, "2026-01-01T00:00:00Z"), 500)
        .unwrap();

    let [stored] = &s.list(&HistoryQuery::default()).unwrap()[..] else {
        panic!("expected one entry");
    };
    assert!(!stored.truncated);
    assert_eq!(stored.sql, exact);
}

#[test]
fn cutting_a_multibyte_statement_does_not_split_a_character() {
    // A cut landing mid-codepoint would panic on the slice. The boundary walk
    // is what stops a query full of non-ASCII text taking the app down.
    let s = store();
    let huge = "é".repeat(MAX_SQL_BYTES);
    let stored = s
        .add(&entry("uni", &huge, "2026-01-01T00:00:00Z"), 500)
        .unwrap();

    assert!(stored.truncated);
    assert!(stored.sql.ends_with(TRUNCATION_MARKER));
}

#[test]
fn import_brings_entries_across_and_keeps_their_ids() {
    let s = store();
    let incoming = vec![
        entry("old-1", "SELECT 1", "2026-01-01T00:00:00Z"),
        entry("old-2", "SELECT 2", "2026-01-01T00:01:00Z"),
    ];

    let imported = s.import(&incoming, 500).unwrap();

    assert_eq!(imported, 2);
    let ids: Vec<_> = s
        .list(&HistoryQuery::default())
        .unwrap()
        .into_iter()
        .map(|e| e.id)
        .collect();
    assert_eq!(ids, vec!["old-2", "old-1"]);
}

#[test]
fn a_repeated_import_does_not_duplicate() {
    // The app being killed midway through a handover must not double the
    // history when it starts again.
    let s = store();
    let incoming = vec![entry("old-1", "SELECT 1", "2026-01-01T00:00:00Z")];

    assert_eq!(s.import(&incoming, 500).unwrap(), 1);
    assert_eq!(s.import(&incoming, 500).unwrap(), 0);
    assert_eq!(s.count().unwrap(), 1);
}

#[test]
fn import_respects_the_limit() {
    let s = store();
    let incoming: Vec<_> = (0..10)
        .map(|i| {
            entry(
                &format!("old-{i}"),
                "SELECT 1",
                &format!("2026-01-01T00:{i:02}:00Z"),
            )
        })
        .collect();

    s.import(&incoming, 4).unwrap();

    assert_eq!(s.count().unwrap(), 4);
}

#[test]
fn a_reopened_database_still_holds_its_entries() {
    let dir = std::env::temp_dir().join(format!("sqlpilot-history-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("history.db");
    let _ = std::fs::remove_file(&path);

    {
        let s = HistoryStore::new(&path).unwrap();
        s.add(&entry("kept", "SELECT 1", "2026-01-01T00:00:00Z"), 500)
            .unwrap();
    }

    let reopened = HistoryStore::new(&path).unwrap();
    assert_eq!(reopened.count().unwrap(), 1);

    let _ = std::fs::remove_dir_all(&dir);
}
