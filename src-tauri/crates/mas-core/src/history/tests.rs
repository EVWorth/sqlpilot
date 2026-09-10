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
        origin: "editor".to_string(),
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

// ====== FILTERING AND SORTING (#589) ======

/// An entry with the fields the filters read.
fn filterable(
    id: &str,
    connection: &str,
    database: Option<&str>,
    status: &str,
    executed_at: &str,
    ms: i64,
) -> HistoryEntry {
    HistoryEntry {
        connection_name: connection.to_string(),
        database: database.map(str::to_string),
        status: status.to_string(),
        execution_time_ms: ms,
        ..entry(id, "SELECT 1", executed_at)
    }
}

fn seeded() -> HistoryStore {
    let s = store();
    for e in [
        filterable(
            "a",
            "prod",
            Some("app"),
            "success",
            "2026-01-01T10:00:00Z",
            10,
        ),
        filterable(
            "b",
            "prod",
            Some("app"),
            "error",
            "2026-01-02T10:00:00Z",
            900,
        ),
        filterable(
            "c",
            "staging",
            Some("app"),
            "success",
            "2026-01-03T10:00:00Z",
            50,
        ),
        filterable(
            "d",
            "staging",
            Some("logs"),
            "error",
            "2026-01-04T10:00:00Z",
            300,
        ),
    ] {
        s.add(&e, 500).unwrap();
    }
    s
}

fn ids(store: &HistoryStore, query: HistoryQuery) -> Vec<String> {
    store
        .list(&query)
        .unwrap()
        .into_iter()
        .map(|e| e.id)
        .collect()
}

#[test]
fn filters_by_connection() {
    let s = seeded();
    let found = ids(
        &s,
        HistoryQuery {
            connection_names: Some(vec!["prod".into()]),
            ..Default::default()
        },
    );
    assert_eq!(found, vec!["b", "a"]);
}

#[test]
fn filters_by_several_connections_at_once() {
    let s = seeded();
    let found = ids(
        &s,
        HistoryQuery {
            connection_names: Some(vec!["prod".into(), "staging".into()]),
            ..Default::default()
        },
    );
    assert_eq!(found.len(), 4);
}

#[test]
fn filters_by_database() {
    let s = seeded();
    let found = ids(
        &s,
        HistoryQuery {
            databases: Some(vec!["logs".into()]),
            ..Default::default()
        },
    );
    assert_eq!(found, vec!["d"]);
}

#[test]
fn filters_by_status() {
    let s = seeded();
    let found = ids(
        &s,
        HistoryQuery {
            status: Some("error".into()),
            ..Default::default()
        },
    );
    assert_eq!(found, vec!["d", "b"]);
}

#[test]
fn filters_by_date_range_inclusively() {
    let s = seeded();
    let found = ids(
        &s,
        HistoryQuery {
            executed_after: Some("2026-01-02T00:00:00Z".into()),
            executed_before: Some("2026-01-03T23:59:59Z".into()),
            ..Default::default()
        },
    );
    assert_eq!(found, vec!["c", "b"]);
}

#[test]
fn filters_by_minimum_duration() {
    let s = seeded();
    let found = ids(
        &s,
        HistoryQuery {
            min_duration_ms: Some(300),
            ..Default::default()
        },
    );
    assert_eq!(found, vec!["d", "b"]);
}

#[test]
fn combines_filters_with_and() {
    // "What failed on staging" — the question the panel could not answer.
    let s = seeded();
    let found = ids(
        &s,
        HistoryQuery {
            connection_names: Some(vec!["staging".into()]),
            status: Some("error".into()),
            ..Default::default()
        },
    );
    assert_eq!(found, vec!["d"]);
}

#[test]
fn a_filter_combines_with_a_search() {
    let s = store();
    s.add(
        &HistoryEntry {
            connection_name: "prod".into(),
            ..entry("hit", "SELECT * FROM orders", "2026-01-01T00:00:00Z")
        },
        500,
    )
    .unwrap();
    s.add(
        &HistoryEntry {
            connection_name: "staging".into(),
            ..entry("miss", "SELECT * FROM orders", "2026-01-02T00:00:00Z")
        },
        500,
    )
    .unwrap();

    let found = ids(
        &s,
        HistoryQuery {
            search: Some("orders".into()),
            connection_names: Some(vec!["prod".into()]),
            ..Default::default()
        },
    );
    assert_eq!(found, vec!["hit"]);
}

#[test]
fn an_empty_filter_list_is_not_a_filter() {
    // An unticked filter group must mean "all", not "none" — otherwise
    // clearing the last checkbox empties the panel.
    let s = seeded();
    let found = ids(
        &s,
        HistoryQuery {
            connection_names: Some(vec![]),
            databases: Some(vec![]),
            ..Default::default()
        },
    );
    assert_eq!(found.len(), 4);
}

#[test]
fn a_name_containing_sql_is_matched_literally() {
    // Filter values are bound, not interpolated. A connection called
    // `prod' OR '1'='1` must match itself and nothing else.
    let s = seeded();
    let odd = "prod' OR '1'='1";
    s.add(
        &filterable(
            "odd",
            odd,
            Some("app"),
            "success",
            "2026-01-05T10:00:00Z",
            1,
        ),
        500,
    )
    .unwrap();

    let found = ids(
        &s,
        HistoryQuery {
            connection_names: Some(vec![odd.into()]),
            ..Default::default()
        },
    );
    assert_eq!(found, vec!["odd"]);
}

#[test]
fn sorts_slowest_first() {
    let s = seeded();
    let found = ids(
        &s,
        HistoryQuery {
            sort: Some(HistorySort::Slowest),
            ..Default::default()
        },
    );
    assert_eq!(found, vec!["b", "d", "c", "a"]);
}

#[test]
fn sorts_by_row_count() {
    let s = store();
    for (id, rows) in [("few", 1), ("many", 900), ("some", 50)] {
        s.add(
            &HistoryEntry {
                row_count: rows,
                ..entry(id, "SELECT 1", "2026-01-01T00:00:00Z")
            },
            500,
        )
        .unwrap();
    }

    let found = ids(
        &s,
        HistoryQuery {
            sort: Some(HistorySort::MostRows),
            ..Default::default()
        },
    );
    assert_eq!(found, vec!["many", "some", "few"]);
}

#[test]
fn sorting_still_respects_the_filters() {
    let s = seeded();
    let found = ids(
        &s,
        HistoryQuery {
            status: Some("error".into()),
            sort: Some(HistorySort::Slowest),
            ..Default::default()
        },
    );
    assert_eq!(found, vec!["b", "d"]);
}

#[test]
fn count_matching_ignores_the_page_size() {
    // The panel says "50 of 812"; without this a full page and a last page
    // look the same.
    let s = seeded();
    let query = HistoryQuery {
        status: Some("error".into()),
        limit: Some(1),
        ..Default::default()
    };

    assert_eq!(s.list(&query).unwrap().len(), 1);
    assert_eq!(s.count_matching(&query).unwrap(), 2);
}

#[test]
fn facets_list_only_what_the_history_holds() {
    let s = seeded();
    let facets = s.facets().unwrap();

    assert_eq!(facets.connection_names, vec!["prod", "staging"]);
    assert_eq!(facets.databases, vec!["app", "logs"]);
}

#[test]
fn facets_skip_entries_with_no_database() {
    let s = store();
    s.add(
        &filterable("none", "prod", None, "success", "2026-01-01T00:00:00Z", 1),
        500,
    )
    .unwrap();

    assert!(s.facets().unwrap().databases.is_empty());
}

// ====== EXPORT (#589) ======

#[test]
fn csv_export_has_a_header_and_a_row_each() {
    let entries = vec![
        filterable(
            "a",
            "prod",
            Some("app"),
            "success",
            "2026-01-01T10:00:00Z",
            10,
        ),
        filterable("b", "prod", None, "error", "2026-01-02T10:00:00Z", 20),
    ];

    let csv = render_export(&entries, HistoryExportFormat::Csv);
    let lines: Vec<_> = csv.lines().collect();

    assert!(lines[0].starts_with("executed_at,connection,database,status"));
    assert_eq!(lines.len(), 3);
    assert!(lines[1].contains("prod"));
}

#[test]
fn csv_quotes_a_statement_containing_commas_and_quotes() {
    let entries = vec![HistoryEntry {
        sql: "SELECT 'a,b', \"c\"".into(),
        ..entry("a", "", "2026-01-01T00:00:00Z")
    }];

    let csv = render_export(&entries, HistoryExportFormat::Csv);

    // Doubled quotes, whole field wrapped — RFC 4180. Without this the comma
    // inside the statement shifts every later column by one.
    assert!(csv.contains("\"SELECT 'a,b', \"\"c\"\"\""));
}

#[test]
fn csv_survives_a_statement_with_a_newline() {
    let entries = vec![HistoryEntry {
        sql: "SELECT 1\nFROM t".into(),
        ..entry("a", "", "2026-01-01T00:00:00Z")
    }];

    let csv = render_export(&entries, HistoryExportFormat::Csv);
    assert!(csv.contains("\"SELECT 1\nFROM t\""));
}

#[test]
fn sql_export_is_runnable() {
    let entries = vec![filterable(
        "a",
        "prod",
        Some("app"),
        "success",
        "2026-01-01T10:00:00Z",
        10,
    )];

    let out = render_export(&entries, HistoryExportFormat::Sql);

    assert!(out.contains("-- 2026-01-01T10:00:00Z · prod/app · success · 10ms"));
    assert!(out.contains("SELECT 1;"));
}

#[test]
fn sql_export_does_not_double_a_semicolon() {
    let entries = vec![entry("a", "SELECT 1;", "2026-01-01T00:00:00Z")];
    let out = render_export(&entries, HistoryExportFormat::Sql);
    assert!(!out.contains("SELECT 1;;"));
}

#[test]
fn sql_export_keeps_an_error_message_inside_its_comment() {
    // A newline in the message would end the comment and leave the rest of it
    // sitting in the file as SQL.
    let entries = vec![HistoryEntry {
        status: "error".into(),
        error: Some("line one\nDROP TABLE users".into()),
        ..entry("a", "SELECT 1", "2026-01-01T00:00:00Z")
    }];

    let out = render_export(&entries, HistoryExportFormat::Sql);

    assert!(out.contains("-- error: line one DROP TABLE users"));
    for line in out.lines() {
        assert!(
            !line.starts_with("DROP TABLE"),
            "an error message must not escape its comment: {line}"
        );
    }
}

#[test]
fn sql_export_warns_that_a_redacted_entry_will_not_run() {
    let entries = vec![HistoryEntry {
        redacted: true,
        ..entry(
            "a",
            "CREATE USER 'a'@'%' IDENTIFIED BY <redacted>",
            "2026-01-01T00:00:00Z",
        )
    }];

    let out = render_export(&entries, HistoryExportFormat::Sql);
    assert!(out.contains("a credential was removed"));
}

#[test]
fn exporting_nothing_still_produces_a_valid_file() {
    assert!(render_export(&[], HistoryExportFormat::Csv).starts_with("executed_at,"));
    assert!(render_export(&[], HistoryExportFormat::Sql).starts_with("-- SQLPilot"));
}

#[test]
fn an_absent_limit_returns_every_match() {
    // An export passes no limit and means all of it. A default page size here
    // would cap the file silently at that number.
    let s = store();
    fill(&s, 600, 1000);

    let all = s.list(&HistoryQuery::default()).unwrap();
    assert_eq!(all.len(), 600);
}

// ====== AGE-BASED RETENTION (#592) ======

#[test]
fn prune_older_than_drops_only_what_predates_the_cutoff() {
    let s = store();
    s.add(&entry("old", "SELECT 1", "2026-01-01T00:00:00Z"), 500)
        .unwrap();
    s.add(&entry("new", "SELECT 2", "2026-03-01T00:00:00Z"), 500)
        .unwrap();

    let removed = s.prune_older_than("2026-02-01T00:00:00Z").unwrap();

    assert_eq!(removed, 1);
    let ids: Vec<_> = s
        .list(&HistoryQuery::default())
        .unwrap()
        .into_iter()
        .map(|e| e.id)
        .collect();
    assert_eq!(ids, vec!["new"]);
}

#[test]
fn an_entry_exactly_at_the_cutoff_is_kept() {
    // "Keep 30 days" must keep the entry from 30 days ago, not drop it.
    let s = store();
    s.add(&entry("edge", "SELECT 1", "2026-02-01T00:00:00Z"), 500)
        .unwrap();

    assert_eq!(s.prune_older_than("2026-02-01T00:00:00Z").unwrap(), 0);
    assert_eq!(s.count().unwrap(), 1);
}

#[test]
fn pruning_an_empty_history_by_age_is_not_an_error() {
    assert_eq!(store().prune_older_than("2026-01-01T00:00:00Z").unwrap(), 0);
}

// ====== ORIGIN (#586) ======

#[test]
fn an_origin_round_trips() {
    let s = store();
    s.add(
        &HistoryEntry {
            origin: "grid".into(),
            ..entry("g", "UPDATE t SET a = 1", "2026-01-01T00:00:00Z")
        },
        500,
    )
    .unwrap();

    assert_eq!(s.list(&HistoryQuery::default()).unwrap()[0].origin, "grid");
}

#[test]
fn filters_by_origin() {
    let s = store();
    for (id, origin) in [("e", "editor"), ("g", "grid"), ("i", "import")] {
        s.add(
            &HistoryEntry {
                origin: origin.into(),
                ..entry(id, "SELECT 1", "2026-01-01T00:00:00Z")
            },
            500,
        )
        .unwrap();
    }

    let found = ids(
        &s,
        HistoryQuery {
            origins: Some(vec!["editor".into(), "grid".into()]),
            ..Default::default()
        },
    );

    assert_eq!(found.len(), 2);
    assert!(!found.contains(&"i".to_string()));
}

#[test]
fn an_empty_origin_list_is_not_a_filter() {
    let s = store();
    s.add(&entry("a", "SELECT 1", "2026-01-01T00:00:00Z"), 500)
        .unwrap();

    let found = ids(
        &s,
        HistoryQuery {
            origins: Some(vec![]),
            ..Default::default()
        },
    );
    assert_eq!(found.len(), 1);
}

#[test]
fn facets_list_the_origins_present() {
    let s = store();
    for (id, origin) in [("a", "editor"), ("b", "grid"), ("c", "grid")] {
        s.add(
            &HistoryEntry {
                origin: origin.into(),
                ..entry(id, "SELECT 1", "2026-01-01T00:00:00Z")
            },
            500,
        )
        .unwrap();
    }

    assert_eq!(s.facets().unwrap().origins, vec!["editor", "grid"]);
}

#[test]
fn a_row_written_before_the_column_existed_reads_as_editor() {
    // The migration defaults to 'editor' because that is the only thing that
    // recorded history before the column existed.
    let s = store();
    {
        let db = s.db.lock().unwrap();
        db.execute(
            "INSERT INTO query_history (id, sql, connection_name, executed_at, status)
             VALUES ('old', 'SELECT 1', 'prod', '2026-01-01T00:00:00Z', 'success')",
            [],
        )
        .unwrap();
    }

    assert_eq!(
        s.list(&HistoryQuery::default()).unwrap()[0].origin,
        "editor"
    );
}
