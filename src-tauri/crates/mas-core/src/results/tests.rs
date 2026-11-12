use super::*;
use crate::models::query::SqlValue::{Bool, Bytes, Float, Int, Null, String as Str, UInt};
use std::time::{Duration, Instant};

const MIB: u64 = 1024 * 1024;

fn col(data_type: &str) -> ColumnMeta {
    ColumnMeta {
        name: format!("a {data_type} column"),
        data_type: data_type.to_string(),
        nullable: true,
        is_primary_key: false,
    }
}

fn cols(types: &[&str]) -> Vec<ColumnMeta> {
    types.iter().map(|t| col(t)).collect()
}

fn open_store(budget: u64) -> (tempfile::TempDir, ResultStore) {
    let dir = tempfile::tempdir().expect("temp dir");
    let store = ResultStore::open(dir.path(), budget).expect("store opens");
    (dir, store)
}

fn put(store: &ResultStore, types: &[&str], rows: &[Vec<SqlValue>]) -> StoredResult {
    let mut writer = store.begin(&cols(types)).expect("begin");
    writer.append(rows).expect("append");
    writer.finish().expect("finish")
}

fn s(text: &str) -> SqlValue {
    Str(text.to_string())
}

/// A request for the first `count` rows with a cell limit nothing in these
/// tests reaches unless they set one.
fn first(count: u32) -> WindowRequest {
    WindowRequest {
        offset: 0,
        count,
        sort: Vec::new(),
        filters: Vec::new(),
        max_cell_bytes: 64 * 1024,
    }
}

fn asc(column: usize) -> SortKey {
    SortKey {
        column,
        descending: false,
    }
}

fn desc(column: usize) -> SortKey {
    SortKey {
        column,
        descending: true,
    }
}

fn filter(column: usize, operator: FilterOperator, value: &str) -> ColumnFilter {
    ColumnFilter {
        column,
        operator,
        value: value.to_string(),
        value2: None,
    }
}

fn values(window: &ResultWindow) -> Vec<Vec<SqlValue>> {
    window
        .rows
        .iter()
        .map(|row| row.iter().map(|cell| cell.value.clone()).collect())
        .collect()
}

/// Equality that is strict where `PartialEq` is loose: the variant must be
/// the same, -0.0 is not 0.0, and NaN is NaN.
fn same(a: &SqlValue, b: &SqlValue) -> bool {
    match (a, b) {
        (Float(x), Float(y)) => (x.is_nan() && y.is_nan()) || x.to_bits() == y.to_bits(),
        _ => std::mem::discriminant(a) == std::mem::discriminant(b) && a == b,
    }
}

fn assert_round_trip(store: &ResultStore, types: &[&str], rows: &[Vec<SqlValue>]) {
    let stored = put(store, types, rows);
    assert_eq!(stored.row_count, rows.len() as u64);

    let window = store
        .window(&stored.result_id, &first(u32::MAX))
        .expect("window");
    assert_eq!(window.matching_rows, rows.len() as u64);
    assert_eq!(window.rows.len(), rows.len());
    for (index, (written, read)) in rows.iter().zip(&window.rows).enumerate() {
        assert_eq!(window.row_ids[index], index as u64 + 1);
        for (column, (expected, cell)) in written.iter().zip(read).enumerate() {
            assert!(
                same(expected, &cell.value),
                "window row {index} column {column}: wrote {expected:?}, read {:?}",
                cell.value
            );
            assert_eq!(cell.full_len, None);
            let whole = store
                .cell(&stored.result_id, index as u64 + 1, column)
                .expect("cell");
            assert!(
                same(expected, &whole),
                "cell row {index} column {column}: wrote {expected:?}, read {whole:?}"
            );
        }
    }
}

fn table_count(store: &ResultStore) -> i64 {
    let mut state = store.inner.lock();
    state
        .conn()
        .expect("open")
        .query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get(0))
        .expect("count")
}

// ---------------------------------------------------------------- values

#[test]
fn every_variant_comes_back_as_itself() {
    let (_dir, store) = open_store(64 * MIB);
    // One column per kind of column the executor produces, each holding the
    // variant that column yields, with the edge values of that variant.
    let types = [
        "TINYINT(1)",
        "INT",
        "INT UNSIGNED",
        "BIT",
        "DOUBLE",
        "VARCHAR",
        "DECIMAL",
        "BLOB",
    ];
    let rows = vec![
        vec![
            Bool(true),
            Int(i64::MIN),
            UInt(0),
            UInt(u64::MAX),
            Float(1.5),
            s(""),
            s("12345678901234567890.123456789"),
            Bytes(vec![]),
        ],
        vec![
            Bool(false),
            Int(i64::MAX),
            UInt(u64::from(u32::MAX)),
            UInt(i64::MAX as u64),
            Float(-0.0),
            s("héllo wörld ✓ 日本語"),
            s("-0.10"),
            Bytes(vec![0, 1, 2, 255, 0]),
        ],
        vec![
            Null,
            Int(0),
            UInt(1),
            UInt(i64::MAX as u64 + 1),
            Float(f64::INFINITY),
            s("NULL"),
            s("0"),
            Bytes(b"plain ascii".to_vec()),
        ],
        vec![
            Bool(true),
            Int(-1),
            Null,
            UInt(1),
            Float(f64::NEG_INFINITY),
            s("123"),
            Null,
            Null,
        ],
        vec![
            Null,
            Null,
            UInt(7),
            Null,
            Float(f64::NAN),
            s("NaN"),
            s("1e5"),
            Bytes(vec![0xff; 3]),
        ],
        vec![
            Bool(false),
            Int(1),
            UInt(8),
            UInt(0),
            Float(f64::MIN_POSITIVE),
            Null,
            s("  padded  "),
            Bytes(vec![b'{']),
        ],
        vec![
            Bool(true),
            Int(2),
            UInt(9),
            UInt(u64::MAX - 1),
            Float(1e308),
            s("\0embedded\0nul"),
            s("9007199254740993"),
            Bytes(vec![0]),
        ],
    ];
    assert_round_trip(&store, &types, &rows);
}

#[test]
fn a_cell_that_does_not_match_its_column_still_comes_back_as_itself() {
    let (_dir, store) = open_store(64 * MIB);
    // The executor falls back to text when it cannot decode a value, so an
    // INT column can hold a string and a BOOL column an integer. Whatever
    // variant set the column's kind first, the others must survive.
    let rows = vec![
        vec![Int(5), Bool(true), s("text"), UInt(u64::MAX)],
        vec![s("5"), Int(1), UInt(u64::MAX), s("18446744073709551615")],
        vec![Bool(true), UInt(1), Int(-3), Float(f64::NAN)],
        vec![UInt(5), s("true"), Bool(false), s("NaN")],
        vec![Float(5.0), Float(1.0), Float(f64::NAN), Int(7)],
        vec![
            Bytes(vec![5]),
            Bytes(vec![1]),
            Bytes(b"text".to_vec()),
            Null,
        ],
        vec![Int(6), Bool(false), s("more"), UInt(u64::MAX - 5)],
    ];
    assert_round_trip(&store, &["INT", "TINYINT(1)", "VARCHAR", "BIT"], &rows);
}

/// A small deterministic generator, so the property test needs no new
/// dependency and a failure reproduces.
struct Random(u64);

impl Random {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }

    fn text(&mut self) -> String {
        const PIECES: [&str; 12] = [
            "", "a", "Z", "é", "ß", "日本", "😀", " ", "0", "-1.5", "NaN", "\n",
        ];
        (0..self.below(6))
            .map(|_| PIECES[self.below(PIECES.len() as u64) as usize])
            .collect()
    }

    fn value(&mut self) -> SqlValue {
        match self.below(12) {
            0 => Null,
            1 => Bool(self.below(2) == 1),
            2 => Int(self.next() as i64),
            3 => Int(self.below(5) as i64 - 2),
            4 => UInt(self.next()),
            5 => UInt(self.below(3)),
            6 => Float(f64::from_bits(self.next())),
            7 => Float(self.below(1000) as f64 / 8.0 - 60.0),
            8 => s(&self.text()),
            9 => s(&self.next().to_string()),
            10 => Bytes((0..self.below(9)).map(|_| self.below(256) as u8).collect()),
            _ => [
                Float(f64::NAN),
                Float(f64::INFINITY),
                Float(-0.0),
                UInt(u64::MAX),
                Int(i64::MIN),
                s(""),
                Bytes(vec![]),
            ][self.below(7) as usize]
                .clone(),
        }
    }
}

#[test]
fn any_value_in_any_column_comes_back_as_itself() {
    let (_dir, store) = open_store(256 * MIB);
    let types = ["INT", "VARCHAR", "DECIMAL", "BLOB", "TINYINT(1)", "DOUBLE"];
    for seed in [1_u64, 0x9e37_79b9_7f4a_7c15, 42, 0xdead_beef] {
        let mut random = Random(seed);
        let rows: Vec<Vec<SqlValue>> = (0..400)
            .map(|_| types.iter().map(|_| random.value()).collect())
            .collect();
        assert_round_trip(&store, &types, &rows);
    }
}

#[test]
fn a_result_with_no_columns_keeps_its_rows() {
    let (_dir, store) = open_store(64 * MIB);
    let stored = put(&store, &[], &[vec![], vec![], vec![]]);
    assert_eq!(stored.row_count, 3);
    let window = store.window(&stored.result_id, &first(10)).expect("window");
    assert_eq!(window.row_ids, vec![1, 2, 3]);
    assert_eq!(window.rows, vec![vec![], vec![], vec![]]);
}

#[test]
fn a_row_of_the_wrong_width_is_refused() {
    let (_dir, store) = open_store(64 * MIB);
    let mut writer = store.begin(&cols(&["INT", "INT"])).expect("begin");
    writer.append(&[vec![Int(1), Int(2)]]).expect("append");
    let err = writer
        .append(&[vec![Int(3), Int(4)], vec![Int(5)]])
        .expect_err("too short");
    assert!(matches!(err, CoreError::Storage(_)), "{err:?}");
    // The whole batch was dropped, not half of it.
    assert_eq!(writer.row_count(), 1);
    let stored = writer.finish().expect("finish");
    let window = store.window(&stored.result_id, &first(10)).expect("window");
    assert_eq!(values(&window), vec![vec![Int(1), Int(2)]]);
}

// ---------------------------------------------------------------- windows

fn numbered(count: i64) -> Vec<Vec<SqlValue>> {
    (1..=count)
        .map(|n| vec![Int(n), s(&format!("row {n}"))])
        .collect()
}

#[test]
fn a_window_is_a_page_of_the_result_in_arrival_order() {
    let (_dir, store) = open_store(64 * MIB);
    let mut writer = store.begin(&cols(&["INT", "VARCHAR"])).expect("begin");
    // Several batches: row ids run on across them.
    for batch in numbered(250).chunks(100) {
        writer.append(batch).expect("append");
    }
    let stored = writer.finish().expect("finish");
    assert_eq!(stored.row_count, 250);

    let page = |offset, count| {
        store
            .window(
                &stored.result_id,
                &WindowRequest {
                    offset,
                    ..first(count)
                },
            )
            .expect("window")
    };

    let start = page(0, 3);
    assert_eq!(start.row_ids, vec![1, 2, 3]);
    assert_eq!(start.matching_rows, 250);
    assert_eq!(start.rows[2][1].value, s("row 3"));

    let middle = page(120, 2);
    assert_eq!(middle.row_ids, vec![121, 122]);
    assert_eq!(middle.rows[0][0].value, Int(121));

    let end = page(248, 50);
    assert_eq!(end.row_ids, vec![249, 250]);
    assert_eq!(end.matching_rows, 250);

    let past = page(250, 50);
    assert!(past.rows.is_empty() && past.row_ids.is_empty());
    assert_eq!(past.matching_rows, 250);

    let none = page(0, 0);
    assert!(none.rows.is_empty());
    assert_eq!(none.matching_rows, 250);
}

#[test]
fn matching_rows_counts_after_filters_and_before_paging() {
    let (_dir, store) = open_store(64 * MIB);
    let stored = put(&store, &["INT", "VARCHAR"], &numbered(100));
    let window = store
        .window(
            &stored.result_id,
            &WindowRequest {
                offset: 5,
                filters: vec![filter(0, FilterOperator::Gt, "80")],
                ..first(4)
            },
        )
        .expect("window");
    assert_eq!(window.matching_rows, 20);
    assert_eq!(window.row_ids, vec![86, 87, 88, 89]);

    // Sorted and filtered together: the page is cut from the sorted matches.
    let window = store
        .window(
            &stored.result_id,
            &WindowRequest {
                offset: 1,
                sort: vec![desc(0)],
                filters: vec![filter(1, FilterOperator::EndsWith, "5")],
                ..first(3)
            },
        )
        .expect("window");
    assert_eq!(window.matching_rows, 10);
    assert_eq!(window.row_ids, vec![85, 75, 65]);
}

#[test]
fn an_unknown_result_row_or_column_is_not_found() {
    let (_dir, store) = open_store(64 * MIB);
    let stored = put(&store, &["INT"], &[vec![Int(1)]]);

    let err = store.window("no-such-result", &first(1)).expect_err("id");
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
    let err = store.cell("no-such-result", 1, 0).expect_err("id");
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
    let err = store.cell(&stored.result_id, 2, 0).expect_err("row");
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
    let err = store.cell(&stored.result_id, 0, 0).expect_err("row 0");
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
    let err = store.cell(&stored.result_id, 1, 1).expect_err("column");
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");

    // A sort or filter on a column the result does not have is the
    // request's fault, and says so instead of reaching SQLite.
    let err = store
        .window(
            &stored.result_id,
            &WindowRequest {
                sort: vec![asc(3)],
                ..first(1)
            },
        )
        .expect_err("sort column");
    assert!(matches!(err, CoreError::Query(_)), "{err:?}");
    let err = store
        .window(
            &stored.result_id,
            &WindowRequest {
                filters: vec![filter(3, FilterOperator::IsNull, "")],
                ..first(1)
            },
        )
        .expect_err("filter column");
    assert!(matches!(err, CoreError::Query(_)), "{err:?}");
}

// ---------------------------------------------------------------- sorting

fn sorted_ids(store: &ResultStore, result_id: &str, sort: Vec<SortKey>) -> Vec<u64> {
    store
        .window(
            result_id,
            &WindowRequest {
                sort,
                ..first(u32::MAX)
            },
        )
        .expect("window")
        .row_ids
}

#[test]
fn sort_uses_every_key_in_order_then_arrival_order() {
    let (_dir, store) = open_store(64 * MIB);
    let stored = put(
        &store,
        &["VARCHAR", "INT"],
        &[
            vec![s("b"), Int(2)], // 1
            vec![s("a"), Int(2)], // 2
            vec![s("b"), Int(1)], // 3
            vec![s("a"), Int(1)], // 4
            vec![s("b"), Int(2)], // 5: a tie with row 1 on both keys
            vec![s("a"), Int(2)], // 6: a tie with row 2
        ],
    );
    let id = &stored.result_id;
    assert_eq!(
        sorted_ids(&store, id, vec![asc(0), asc(1)]),
        [4, 2, 6, 3, 1, 5]
    );
    assert_eq!(
        sorted_ids(&store, id, vec![asc(0), desc(1)]),
        [2, 6, 4, 1, 5, 3]
    );
    assert_eq!(
        sorted_ids(&store, id, vec![desc(1), asc(0)]),
        [2, 6, 1, 5, 4, 3]
    );
    // Ties keep arrival order in both directions: the row id is the last
    // key and is never reversed.
    assert_eq!(sorted_ids(&store, id, vec![asc(1)]), [3, 4, 1, 2, 5, 6]);
    assert_eq!(sorted_ids(&store, id, vec![desc(1)]), [1, 2, 5, 6, 3, 4]);
    assert_eq!(sorted_ids(&store, id, vec![]), [1, 2, 3, 4, 5, 6]);
}

#[test]
fn null_sorts_first_ascending_and_last_descending() {
    let (_dir, store) = open_store(64 * MIB);
    let stored = put(
        &store,
        &["INT", "VARCHAR", "DECIMAL"],
        &[
            vec![Int(2), s("b"), s("2.5")],
            vec![Null, Null, Null],
            vec![Int(-1), s("a"), s("-1.5")],
            vec![Null, Null, Null],
            vec![Int(1), s("ab"), s("0")],
        ],
    );
    let id = &stored.result_id;
    for column in 0..3 {
        assert_eq!(
            sorted_ids(&store, id, vec![asc(column)]),
            [2, 4, 3, 5, 1],
            "column {column} ascending"
        );
        assert_eq!(
            sorted_ids(&store, id, vec![desc(column)]),
            [1, 5, 3, 2, 4],
            "column {column} descending"
        );
    }
}

#[test]
fn numbers_kept_as_text_sort_as_numbers() {
    let (_dir, store) = open_store(64 * MIB);
    let stored = put(
        &store,
        &["DECIMAL(30,10)", "BIGINT", "VARCHAR"],
        &[
            vec![s("10.5"), s("9007199254740993"), s("10")],
            vec![s("9.75"), s("9007199254740992"), s("9")],
            vec![s("-100.25"), s("-9223372036854775808"), s("-100")],
            vec![s("100"), s("9223372036854775807"), s("100")],
            vec![s("9.8"), s("9"), s("9.8")],
            // The same f64 as the next row; only the digits differ.
            vec![s("12345678901234567890.0000000001"), s("10"), s("x")],
            vec![s("12345678901234567890.0000000002"), s("-10"), s("y")],
        ],
    );
    let id = &stored.result_id;
    assert_eq!(sorted_ids(&store, id, vec![asc(0)]), [3, 2, 5, 1, 4, 6, 7]);
    assert_eq!(sorted_ids(&store, id, vec![desc(0)]), [7, 6, 4, 1, 5, 2, 3]);
    assert_eq!(sorted_ids(&store, id, vec![asc(1)]), [3, 7, 5, 6, 2, 1, 4]);
    // The same digits in a text column sort as text.
    assert_eq!(sorted_ids(&store, id, vec![asc(2)]), [3, 1, 4, 2, 5, 6, 7]);
}

#[test]
fn unsigned_values_either_side_of_the_integer_limit_sort_together() {
    let (_dir, store) = open_store(64 * MIB);
    let limit = i64::MAX as u64;
    let stored = put(
        &store,
        &["BIT"],
        &[
            vec![UInt(u64::MAX)],     // 1: text
            vec![UInt(5)],            // 2: integer
            vec![UInt(limit + 1)],    // 3: text
            vec![UInt(limit)],        // 4: integer
            vec![Null],               // 5
            vec![UInt(u64::MAX - 1)], // 6: text
            vec![UInt(0)],            // 7: integer
            vec![UInt(limit + 2)],    // 8: text
        ],
    );
    let id = &stored.result_id;
    assert_eq!(
        sorted_ids(&store, id, vec![asc(0)]),
        [5, 7, 2, 4, 3, 8, 6, 1]
    );
    assert_eq!(
        sorted_ids(&store, id, vec![desc(0)]),
        [1, 6, 8, 3, 4, 2, 7, 5]
    );
}

#[test]
fn a_numeric_column_of_mixed_storage_sorts_by_value() {
    let (_dir, store) = open_store(64 * MIB);
    // What a SQLite NUMERIC column can hold: integers, reals and exact
    // decimal text side by side.
    let stored = put(
        &store,
        &["NUMERIC"],
        &[
            vec![s("2.50")],                   // 1
            vec![Int(3)],                      // 2
            vec![Float(2.25)],                 // 3
            vec![s("-1")],                     // 4
            vec![Float(f64::INFINITY)],        // 5
            vec![Int(-2)],                     // 6
            vec![s("not a number")],           // 7
            vec![Float(f64::NEG_INFINITY)],    // 8
            vec![Float(1e21)],                 // 9
            vec![s("1000000000000000000001")], // 10
        ],
    );
    assert_eq!(
        sorted_ids(&store, &stored.result_id, vec![asc(0)]),
        [8, 6, 4, 3, 1, 2, 9, 10, 5, 7]
    );
}

#[test]
fn floats_and_integers_sort_numerically() {
    let (_dir, store) = open_store(64 * MIB);
    let stored = put(
        &store,
        &["DOUBLE", "INT"],
        &[
            vec![Float(10.5), Int(10)],
            vec![Float(-0.5), Int(9)],
            vec![Float(9.25), Int(-100)],
            vec![Float(1e300), Int(100)],
            vec![Float(f64::NEG_INFINITY), Int(0)],
        ],
    );
    let id = &stored.result_id;
    assert_eq!(sorted_ids(&store, id, vec![asc(0)]), [5, 2, 3, 1, 4]);
    assert_eq!(sorted_ids(&store, id, vec![asc(1)]), [3, 5, 2, 1, 4]);
}

#[test]
fn text_sorts_without_regard_to_case_with_a_binary_tiebreak() {
    let (_dir, store) = open_store(64 * MIB);
    let stored = put(
        &store,
        &["VARCHAR"],
        &[
            vec![s("banana")], // 1
            vec![s("Apple")],  // 2
            vec![s("cherry")], // 3
            vec![s("apple")],  // 4
            vec![s("BANANA")], // 5
            vec![s("Éclair")], // 6
            vec![s("éclair")], // 7
            vec![s("")],       // 8
            vec![s("Apple")],  // 9: equal to row 2, so arrival order decides
        ],
    );
    let id = &stored.result_id;
    assert_eq!(
        sorted_ids(&store, id, vec![asc(0)]),
        [8, 2, 9, 4, 5, 1, 3, 6, 7]
    );
    assert_eq!(
        sorted_ids(&store, id, vec![desc(0)]),
        [7, 6, 3, 1, 5, 4, 2, 9, 8]
    );
}

// ---------------------------------------------------------------- filters

fn filtered_ids(store: &ResultStore, result_id: &str, filters: Vec<ColumnFilter>) -> Vec<u64> {
    store
        .window(
            result_id,
            &WindowRequest {
                filters,
                ..first(u32::MAX)
            },
        )
        .expect("window")
        .row_ids
}

#[test]
fn each_filter_operator_narrows_a_stored_result() {
    use FilterOperator as Op;
    let (_dir, store) = open_store(64 * MIB);
    let stored = put(
        &store,
        &[
            "VARCHAR",
            "INT",
            "DECIMAL",
            "TINYINT(1)",
            "BLOB",
            "DATETIME",
        ],
        &[
            vec![
                s("Alice"),
                Int(9),
                s("9.50"),
                Bool(true),
                Bytes(vec![1, 2]),
                s("2026-03-04 10:00:00"),
            ],
            vec![
                s("bob"),
                Int(10),
                s("10.25"),
                Bool(false),
                Null,
                s("2025-12-31 23:59:59"),
            ],
            vec![Null, Null, Null, Null, Null, Null],
            vec![
                s("ALICIA"),
                Int(100),
                s("100"),
                Bool(true),
                Bytes(b"alice".to_vec()),
                s("2026-12-31 00:00:00"),
            ],
            vec![
                s("a1b"),
                Int(-5),
                s("-5.5"),
                Bool(false),
                Bytes(vec![]),
                s("2027-01-01 00:00:00"),
            ],
        ],
    );
    let id = &stored.result_id;
    let one = |column, operator, value: &str| {
        filtered_ids(&store, id, vec![filter(column, operator, value)])
    };
    let range = |column, low: &str, high: &str| {
        filtered_ids(
            &store,
            id,
            vec![ColumnFilter {
                value2: Some(high.to_string()),
                ..filter(column, Op::Between, low)
            }],
        )
    };

    assert_eq!(one(0, Op::Contains, "LI"), [1, 4]);
    assert_eq!(one(0, Op::NotContains, "li"), [2, 5]);
    assert_eq!(one(0, Op::Equals, "BOB"), [2]);
    assert_eq!(one(0, Op::NotEquals, "bob"), [1, 4, 5]);
    assert_eq!(one(0, Op::StartsWith, "ali"), [1, 4]);
    assert_eq!(one(0, Op::EndsWith, "B"), [2, 5]);
    assert_eq!(one(0, Op::Regex, "^a\\db$"), [5]);
    assert_eq!(one(0, Op::Regex, "^ALI(ce|cia)$"), [1, 4]);
    // A pattern that does not compile shows every row, NULL included: the
    // TypeScript returns before it looks at the pattern only for NULL.
    assert_eq!(one(0, Op::Regex, "a(b"), [1, 2, 4, 5]);
    assert_eq!(one(0, Op::IsNull, ""), [3]);
    assert_eq!(one(0, Op::IsNotNull, ""), [1, 2, 4, 5]);

    assert_eq!(one(1, Op::Gt, "9"), [2, 4]);
    assert_eq!(one(1, Op::Gte, "9"), [1, 2, 4]);
    assert_eq!(one(1, Op::Lt, "10"), [1, 5]);
    assert_eq!(one(1, Op::Lte, "10"), [1, 2, 5]);
    assert_eq!(range(1, "9", "10"), [1, 2]);
    // An integer is searched by its digits.
    assert_eq!(one(1, Op::Contains, "0"), [2, 4]);

    // DECIMAL is text in the store and a number to the filter.
    assert_eq!(one(2, Op::Gt, "9.5"), [2, 4]);
    assert_eq!(one(2, Op::Lt, "10"), [1, 5]);
    assert_eq!(range(2, "-6", "9.5"), [1, 5]);

    // A boolean is searched as the word the grid shows.
    assert_eq!(one(3, Op::Equals, "true"), [1, 4]);
    assert_eq!(one(3, Op::Contains, "als"), [2, 5]);

    // Binary: only the NULL operators apply.
    assert_eq!(one(4, Op::IsNull, ""), [2, 3]);
    assert_eq!(one(4, Op::IsNotNull, ""), [1, 4, 5]);
    assert_eq!(one(4, Op::Contains, "alice"), Vec::<u64>::new());
    assert_eq!(one(4, Op::NotContains, "alice"), Vec::<u64>::new());
    assert_eq!(one(4, Op::Gte, "0"), Vec::<u64>::new());

    // Dates compare as text, which is their order.
    assert_eq!(range(5, "2026-01-01", "2026-12-31 23:59:59"), [1, 4]);
    assert_eq!(one(5, Op::Lt, "2026"), [2]);
}

#[test]
fn filters_combine_and_empty_ones_are_ignored() {
    use FilterOperator as Op;
    let (_dir, store) = open_store(64 * MIB);
    let stored = put(&store, &["INT", "VARCHAR"], &numbered(50));
    let id = &stored.result_id;

    assert_eq!(
        filtered_ids(
            &store,
            id,
            vec![filter(0, Op::Gte, "10"), filter(1, Op::EndsWith, "5")]
        ),
        [15, 25, 35, 45]
    );

    // Nothing typed: opening the filter menu must not empty the grid.
    let inactive = vec![
        filter(0, Op::Contains, ""),
        filter(1, Op::Equals, "   "),
        filter(0, Op::Between, "1"),
        // Not even its column is checked: it is not a filter yet.
        filter(99, Op::Gt, " "),
    ];
    let window = store
        .window(
            id,
            &WindowRequest {
                filters: inactive,
                ..first(u32::MAX)
            },
        )
        .expect("window");
    assert_eq!(window.matching_rows, 50);
    assert_eq!(window.rows.len(), 50);
}

#[test]
fn a_filter_value_is_data_and_never_sql() {
    use FilterOperator as Op;
    let (_dir, store) = open_store(64 * MIB);
    let hostile = "x'); DROP TABLE r1; --";
    let stored = put(
        &store,
        &["VARCHAR"],
        &[
            vec![s(hostile)],
            vec![s("ordinary")],
            vec![s("100% \"quoted\" ?1")],
        ],
    );
    let id = &stored.result_id;
    assert_eq!(
        filtered_ids(&store, id, vec![filter(0, Op::Equals, hostile)]),
        [1]
    );
    assert_eq!(
        filtered_ids(&store, id, vec![filter(0, Op::Contains, "\"quoted\" ?1")]),
        [3]
    );
    assert_eq!(filtered_ids(&store, id, vec![]), [1, 2, 3]);
}

// ---------------------------------------------------------------- big cells

#[test]
fn a_long_cell_is_cut_to_the_limit_and_reports_its_real_length() {
    let (_dir, store) = open_store(64 * MIB);
    let long_text = "abcdefghij".repeat(30); // 300 bytes
    let long_bytes: Vec<u8> = (0..=255).cycle().take(1000).collect();
    let stored = put(
        &store,
        &["TEXT", "BLOB", "INT"],
        &[
            vec![s(&long_text), Bytes(long_bytes.clone()), Int(1)],
            vec![s("short"), Bytes(vec![9, 9]), Int(2)],
            vec![Null, Null, Null],
            // Exactly at the limit: whole, and not marked as cut.
            vec![s(&"x".repeat(100)), Bytes(vec![7; 100]), Int(4)],
            vec![s(&"x".repeat(101)), Bytes(vec![7; 101]), Int(5)],
        ],
    );
    let id = &stored.result_id;
    let window = store
        .window(
            id,
            &WindowRequest {
                max_cell_bytes: 100,
                ..first(10)
            },
        )
        .expect("window");

    let cell = |row: usize, column: usize| window.rows[row][column].clone();
    assert_eq!(
        cell(0, 0),
        Cell {
            value: s(&long_text[..100]),
            full_len: Some(300)
        }
    );
    assert_eq!(
        cell(0, 1),
        Cell {
            value: Bytes(long_bytes[..100].to_vec()),
            full_len: Some(1000)
        }
    );
    assert_eq!(
        cell(0, 2),
        Cell {
            value: Int(1),
            full_len: None
        }
    );
    assert_eq!(
        cell(1, 0),
        Cell {
            value: s("short"),
            full_len: None
        }
    );
    assert_eq!(
        cell(1, 1),
        Cell {
            value: Bytes(vec![9, 9]),
            full_len: None
        }
    );
    assert_eq!(
        cell(2, 0),
        Cell {
            value: Null,
            full_len: None
        }
    );
    assert_eq!(
        cell(2, 1),
        Cell {
            value: Null,
            full_len: None
        }
    );
    assert_eq!(
        cell(3, 0),
        Cell {
            value: s(&"x".repeat(100)),
            full_len: None
        }
    );
    assert_eq!(
        cell(3, 1),
        Cell {
            value: Bytes(vec![7; 100]),
            full_len: None
        }
    );
    assert_eq!(
        cell(4, 0),
        Cell {
            value: s(&"x".repeat(100)),
            full_len: Some(101)
        }
    );
    assert_eq!(
        cell(4, 1),
        Cell {
            value: Bytes(vec![7; 100]),
            full_len: Some(101)
        }
    );

    // The whole value is one call away.
    assert_eq!(store.cell(id, 1, 0).expect("cell"), s(&long_text));
    assert_eq!(store.cell(id, 1, 1).expect("cell"), Bytes(long_bytes));
    assert_eq!(store.cell(id, 3, 0).expect("cell"), Null);
}

#[test]
fn text_is_cut_on_a_character_boundary() {
    let (_dir, store) = open_store(64 * MIB);
    // 'é' is two bytes, '日' three, '😀' four.
    let accents = "é".repeat(200);
    let kanji = "日".repeat(200);
    let faces = "😀".repeat(200);
    let mixed = format!("{}é", "a".repeat(99)); // the é straddles byte 100
    let stored = put(
        &store,
        &["TEXT"],
        &[
            vec![s(&accents)],
            vec![s(&kanji)],
            vec![s(&faces)],
            vec![s(&mixed)],
        ],
    );
    let read = |limit: u32| {
        store
            .window(
                &stored.result_id,
                &WindowRequest {
                    max_cell_bytes: limit,
                    ..first(10)
                },
            )
            .expect("window")
            .rows
            .into_iter()
            .map(|mut row| row.remove(0))
            .collect::<Vec<_>>()
    };

    let cells = read(100);
    assert_eq!(
        cells[0],
        Cell {
            value: s(&"é".repeat(50)),
            full_len: Some(400)
        }
    );
    // 100 is not a multiple of 3: 33 characters, 99 bytes.
    assert_eq!(
        cells[1],
        Cell {
            value: s(&"日".repeat(33)),
            full_len: Some(600)
        }
    );
    assert_eq!(
        cells[2],
        Cell {
            value: s(&"😀".repeat(25)),
            full_len: Some(800)
        }
    );
    assert_eq!(
        cells[3],
        Cell {
            value: s(&"a".repeat(99)),
            full_len: Some(101)
        }
    );

    // Odd limits, below the store's own minimum fetch: never half a
    // character, never more than the limit.
    for limit in [0_u32, 1, 2, 3, 5, 7, 63, 64, 65, 97] {
        for (cell, whole) in read(limit).iter().zip([&accents, &kanji, &faces, &mixed]) {
            let Str(text) = &cell.value else {
                panic!("not a string: {cell:?}");
            };
            assert!(
                text.len() <= limit as usize,
                "limit {limit}: {} bytes",
                text.len()
            );
            assert!(whole.starts_with(text.as_str()), "limit {limit}");
            let next = whole[text.len()..].chars().next().map_or(0, char::len_utf8);
            assert!(
                text.len() + next > limit as usize,
                "limit {limit}: cut too early"
            );
            assert_eq!(cell.full_len, Some(whole.len() as u64), "limit {limit}");
        }
    }
}

#[test]
fn a_number_kept_as_text_is_never_cut() {
    let (_dir, store) = open_store(64 * MIB);
    let stored = put(
        &store,
        &["BIT", "VARCHAR"],
        &[
            vec![UInt(u64::MAX), s("a long enough string to be cut")],
            vec![UInt(u64::MAX - 1), s("ok")],
        ],
    );
    let window = store
        .window(
            &stored.result_id,
            &WindowRequest {
                max_cell_bytes: 4,
                ..first(10)
            },
        )
        .expect("window");
    // Twenty digits against a limit of four: half a number is another
    // number, so it comes whole and unmarked.
    assert_eq!(
        window.rows[0][0],
        Cell {
            value: UInt(u64::MAX),
            full_len: None
        }
    );
    assert_eq!(
        window.rows[1][0],
        Cell {
            value: UInt(u64::MAX - 1),
            full_len: None
        }
    );
    assert_eq!(
        window.rows[0][1],
        Cell {
            value: s("a lo"),
            full_len: Some(30)
        }
    );
    assert_eq!(
        window.rows[1][1],
        Cell {
            value: s("ok"),
            full_len: None
        }
    );
}

// ---------------------------------------------------------------- lifetime

#[test]
fn the_budget_stops_a_write_and_keeps_the_rows_before_it() {
    let (_dir, store) = open_store(MIB);
    let batch: Vec<Vec<SqlValue>> = (0..100)
        .map(|n| vec![Int(n), s(&"x".repeat(1000))])
        .collect();

    let mut writer = store.begin(&cols(&["INT", "TEXT"])).expect("begin");
    let mut batches = 0_u64;
    let err = loop {
        match writer.append(&batch) {
            Ok(()) => batches += 1,
            Err(e) => break e,
        }
        assert!(batches < 100, "the budget never stopped the write");
    };
    assert!(matches!(err, CoreError::ResultStoreFull(_)), "{err:?}");
    assert!(batches >= 1, "one batch fits in a megabyte");
    assert_eq!(writer.row_count(), batches * 100);

    // The file never grew past the budget.
    let size = std::fs::metadata(&store.inner.path).expect("file").len();
    assert!(size <= MIB, "{size} bytes");

    // Full is not broken: the same error again, and what was written reads.
    let err = writer.append(&batch).expect_err("still full");
    assert!(matches!(err, CoreError::ResultStoreFull(_)), "{err:?}");
    let stored = writer.finish().expect("finish");
    assert_eq!(stored.row_count, batches * 100);
    let window = store
        .window(
            &stored.result_id,
            &WindowRequest {
                offset: stored.row_count - 1,
                ..first(5)
            },
        )
        .expect("window");
    assert_eq!(window.row_ids, vec![stored.row_count]);
    assert_eq!(window.rows[0][0].value, Int(99));
    assert_eq!(window.rows[0][1].value, s(&"x".repeat(1000)));

    // Releasing it gives the space back to the next result.
    store.release(&[stored.result_id]);
    let mut writer = store.begin(&cols(&["INT", "TEXT"])).expect("begin");
    writer.append(&batch).expect("room again");
}

#[test]
fn release_and_an_abandoned_writer_remove_their_tables() {
    let (_dir, store) = open_store(64 * MIB);
    assert_eq!(table_count(&store), 0);

    let kept = put(&store, &["INT"], &[vec![Int(1)]]);
    // This one has a mismatched cell, so it owns a side table too.
    let mixed = put(&store, &["INT"], &[vec![Int(1)], vec![Bool(true)]]);
    let plain = put(&store, &["INT"], &[vec![Int(1)]]);
    // SQLite counts the side table's primary key as an entry of its own.
    let with_all = table_count(&store);
    assert!(with_all >= 4, "{with_all}");

    store.release(&[
        mixed.result_id.clone(),
        "never-existed".to_string(),
        plain.result_id.clone(),
    ]);
    assert_eq!(table_count(&store), 1);
    let err = store.window(&mixed.result_id, &first(1)).expect_err("gone");
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
    // Releasing twice is not an error.
    store.release(&[mixed.result_id]);

    {
        let mut writer = store.begin(&cols(&["INT"])).expect("begin");
        writer
            .append(&[vec![Int(1)], vec![s("mismatch")]])
            .expect("append");
        assert!(table_count(&store) > 1);
        // Dropped without `finish`: the query failed or was cancelled.
    }
    assert_eq!(table_count(&store), 1);

    // The survivor is untouched.
    let window = store.window(&kept.result_id, &first(5)).expect("window");
    assert_eq!(values(&window), vec![vec![Int(1)]]);
}

fn store_files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("read dir")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn opening_sweeps_files_left_by_a_crash_and_dropping_deletes_its_own() {
    let dir = tempfile::tempdir().expect("temp dir");
    for stale in [
        "results-11111111-2222-3333-4444-555555555555.db",
        "results-11111111-2222-3333-4444-555555555555.db-journal",
        "results-old.db-wal",
    ] {
        std::fs::write(dir.path().join(stale), b"left behind").expect("write");
    }
    // Not the store's: left alone.
    std::fs::write(dir.path().join("history.db"), b"keep").expect("write");
    std::fs::write(dir.path().join("results.txt"), b"keep").expect("write");

    let store = ResultStore::open(dir.path(), 64 * MIB).expect("open");
    let files = store_files(dir.path());
    assert_eq!(files.len(), 3, "{files:?}");
    assert!(files.contains(&"history.db".to_string()));
    assert!(files.contains(&"results.txt".to_string()));
    let own = store
        .inner
        .path
        .file_name()
        .expect("file name")
        .to_string_lossy()
        .into_owned();
    assert!(own.starts_with("results-") && own.ends_with(".db"), "{own}");
    assert!(files.contains(&own));

    put(&store, &["INT"], &[vec![Int(1)]]);
    drop(store);
    assert_eq!(store_files(dir.path()), ["history.db", "results.txt"]);
}

#[test]
fn the_store_directory_is_created_when_missing() {
    let dir = tempfile::tempdir().expect("temp dir");
    let nested = dir.path().join("cache").join("results");
    let _store = ResultStore::open(&nested, 64 * MIB).expect("open");
    assert_eq!(store_files(&nested).len(), 1);
}

#[cfg(unix)]
#[test]
fn the_store_file_is_readable_by_its_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, store) = open_store(64 * MIB);
    put(&store, &["INT"], &[vec![Int(1)]]);
    let mode = std::fs::metadata(&store.inner.path)
        .expect("file")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600, "{mode:o}");
    // SQLite keeps its journal in memory: nothing else appears beside it
    // that could carry different permissions.
    let dir = store.inner.path.parent().expect("parent");
    assert_eq!(store_files(dir).len(), 1);
}

#[test]
fn a_window_is_read_while_another_result_is_being_written() {
    use std::sync::mpsc;
    let (_dir, store) = open_store(64 * MIB);
    let store = Arc::new(store);
    let finished = put(&store, &["INT", "VARCHAR"], &numbered(500));

    let (to_reader, from_writer) = mpsc::channel::<u64>();
    let (to_writer, from_reader) = mpsc::channel::<()>();
    let writer_store = Arc::clone(&store);
    let writer_thread = std::thread::spawn(move || {
        let mut writer = writer_store
            .begin(&cols(&["INT", "VARCHAR"]))
            .expect("begin");
        // Stop between batches with the result half written, and stay there
        // until the reader has had its turn. If a writer held the store's
        // lock for its whole ingest, the reader would never answer and this
        // would time out.
        for round in 0..3 {
            writer.append(&numbered(1000)).expect("append");
            to_reader.send(writer.row_count()).expect("send");
            from_reader
                .recv_timeout(Duration::from_secs(30))
                .unwrap_or_else(|_| panic!("the reader was blocked in round {round}"));
        }
        writer.finish().expect("finish")
    });

    for round in 1..=3_u64 {
        let written = from_writer
            .recv_timeout(Duration::from_secs(30))
            .expect("writer reached a batch boundary");
        assert_eq!(written, round * 1000);
        let window = store
            .window(
                &finished.result_id,
                &WindowRequest {
                    offset: 100 * round,
                    sort: vec![desc(0)],
                    ..first(3)
                },
            )
            .expect("read during a write");
        assert_eq!(window.matching_rows, 500);
        assert_eq!(window.row_ids[0], 500 - 100 * round);
        to_writer.send(()).expect("send");
    }

    let written = writer_thread.join().expect("writer thread");
    assert_eq!(written.row_count, 3000);
    let window = store
        .window(&written.result_id, &first(1))
        .expect("the new result reads too");
    assert_eq!(window.matching_rows, 3000);
}

#[test]
fn wire_types_use_snake_case_fields() {
    let window = ResultWindow {
        row_ids: vec![7],
        rows: vec![vec![
            Cell {
                value: s("abc"),
                full_len: Some(300),
            },
            Cell {
                value: Null,
                full_len: None,
            },
        ]],
        matching_rows: 42,
    };
    let json = serde_json::to_value(&window).expect("serialises");
    assert_eq!(
        json,
        serde_json::json!({
            "row_ids": [7],
            "rows": [[
                { "value": "abc", "full_len": 300 },
                { "value": null, "full_len": null },
            ]],
            "matching_rows": 42,
        })
    );

    let key: SortKey =
        serde_json::from_str(r#"{"column":3,"descending":true}"#).expect("deserialises");
    assert_eq!(key, desc(3));

    let stored = StoredResult {
        result_id: "id".to_string(),
        row_count: 5,
    };
    assert_eq!(
        serde_json::to_value(&stored).expect("serialises"),
        serde_json::json!({ "result_id": "id", "row_count": 5 })
    );
}

// ---------------------------------------------------------------- measurement

/// Resident memory of this process, in MB.
fn rss_mb() -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap_or_default()
        .lines()
        .find(|line| line.starts_with("VmRSS:"))
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|kb| kb.parse::<f64>().ok())
        .map_or(0.0, |kb| kb / 1024.0)
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

/// Time `read` a few times and report the fastest and the first, since the
/// first run also pays for pages not yet in the cache.
fn time_window(label: &str, store: &ResultStore, result_id: &str, request: &WindowRequest) {
    let mut times = Vec::new();
    let mut rows = 0;
    for _ in 0..5 {
        let start = Instant::now();
        let window = store.window(result_id, request).expect("window");
        times.push(ms(start.elapsed()));
        rows = window.rows.len();
    }
    let best = times.iter().copied().fold(f64::INFINITY, f64::min);
    println!(
        "{label:<34}{best:8.2} ms (first {:.2} ms, {rows} rows)",
        times[0]
    );
}

/// Write `total` rows in batches of `batch_size`, timing only the store.
fn measure_write(
    store: &ResultStore,
    types: &[&str],
    total: usize,
    batch_size: usize,
    make_row: impl Fn(usize) -> Vec<SqlValue>,
) -> StoredResult {
    let rss_before = rss_mb();
    let mut spent = Duration::ZERO;

    let start = Instant::now();
    let mut writer = store.begin(&cols(types)).expect("begin");
    spent += start.elapsed();

    let mut payload = 0_usize;
    let mut next = 0;
    while next < total {
        let end = (next + batch_size).min(total);
        // Building the rows stands in for the server and is not timed.
        let batch: Vec<Vec<SqlValue>> = (next..end).map(&make_row).collect();
        payload += batch
            .iter()
            .flatten()
            .map(|value| match value {
                Null => 0,
                Bool(_) => 1,
                Int(_) | UInt(_) | Float(_) => 8,
                Str(text) => text.len(),
                Bytes(bytes) => bytes.len(),
            })
            .sum::<usize>();
        let start = Instant::now();
        writer.append(&batch).expect("append");
        spent += start.elapsed();
        next = end;
    }

    let start = Instant::now();
    let stored = writer.finish().expect("finish");
    spent += start.elapsed();

    let file = std::fs::metadata(&store.inner.path).expect("file").len();
    println!("rows                              {total:8} in batches of {batch_size}");
    println!(
        "cell data                         {:8.1} MB",
        payload as f64 / 1048576.0
    );
    println!("append + finish                   {:8.1} ms", ms(spent));
    println!(
        "store file                        {:8.1} MB",
        file as f64 / 1048576.0
    );
    println!(
        "RSS before / after write          {rss_before:8.1} / {:.1} MB",
        rss_mb()
    );
    stored
}

/// How fast and how big the store is (#967). Not a pass/fail test: it prints
/// the numbers the design's write-speed target is checked against.
///
/// ```text
/// cargo test -p mas-core --release --lib results::tests::measure -- --ignored --nocapture --test-threads 1
/// ```
#[test]
#[ignore = "a measurement; run it in --release"]
fn measure_narrow_100k() {
    let (_dir, store) = open_store(4096 * MIB);
    println!("== 100,000 narrow rows, 7 columns");
    // The shape of `mem_narrow` in tests/memory_baseline.rs, in the variants
    // the executor yields for those column types.
    let types = [
        "INT",
        "VARCHAR",
        "VARCHAR",
        "DATETIME",
        "DECIMAL",
        "TINYINT(1)",
        "VARCHAR",
    ];
    let stored = measure_write(&store, &types, 100_000, 1000, |index| {
        let n = index as i64 + 1;
        vec![
            Int(n),
            Str(format!("Customer {n}")),
            Str(format!("customer{n}@example.com")),
            Str(format!(
                "2026-{:02}-{:02} {:02}:{:02}:00",
                1 + n % 12,
                1 + n % 28,
                n % 24,
                n % 60
            )),
            Str(format!("{:.2}", n as f64 * 1.37)),
            Bool(n % 2 == 1),
            Str(format!(
                "Order note for customer {n} with some ordinary text in it"
            )),
        ]
    });
    let id = &stored.result_id;

    time_window("200 rows at offset 0", &store, id, &first(200));
    time_window(
        "200 rows at offset 90,000",
        &store,
        id,
        &WindowRequest {
            offset: 90_000,
            ..first(200)
        },
    );
    time_window(
        "200 rows sorted by text (name)",
        &store,
        id,
        &WindowRequest {
            sort: vec![asc(1)],
            ..first(200)
        },
    );
    time_window(
        "200 rows sorted by DECIMAL desc",
        &store,
        id,
        &WindowRequest {
            sort: vec![desc(4)],
            ..first(200)
        },
    );
    time_window(
        "200 rows, sorted, at offset 90,000",
        &store,
        id,
        &WindowRequest {
            offset: 90_000,
            sort: vec![asc(1)],
            ..first(200)
        },
    );
    time_window(
        "200 rows, note contains '77'",
        &store,
        id,
        &WindowRequest {
            filters: vec![filter(6, FilterOperator::Contains, "77")],
            ..first(200)
        },
    );
    println!("RSS after reads                   {:8.1} MB", rss_mb());
}

#[test]
#[ignore = "a measurement; run it in --release"]
fn measure_blob_100mb() {
    let (_dir, store) = open_store(4096 * MIB);
    println!("== 100 rows with a 1 MB BLOB each");
    let stored = measure_write(&store, &["INT", "VARCHAR", "LONGBLOB"], 100, 10, |index| {
        // Bytes that do not compress or repeat from row to row.
        let mut random = Random(index as u64 + 1);
        let mut body = Vec::with_capacity(1024 * 1024);
        while body.len() < 1024 * 1024 {
            body.extend_from_slice(&random.next().to_le_bytes());
        }
        vec![
            Int(index as i64 + 1),
            Str(format!("file-{}", index + 1)),
            Bytes(body),
        ]
    });
    let id = &stored.result_id;

    time_window("100 rows, cells cut to 64 KB", &store, id, &first(200));
    time_window(
        "100 rows sorted by text (name)",
        &store,
        id,
        &WindowRequest {
            sort: vec![desc(1)],
            ..first(200)
        },
    );
    let start = Instant::now();
    let whole = store.cell(id, 50, 2).expect("cell");
    println!(
        "one whole 1 MB cell               {:8.2} ms",
        ms(start.elapsed())
    );
    assert!(matches!(whole, Bytes(bytes) if bytes.len() == 1024 * 1024));
    println!("RSS after reads                   {:8.1} MB", rss_mb());
}
