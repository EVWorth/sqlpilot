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

fn filter(column: usize, operator: FilterOperator, value: &str) -> ResultFilter {
    ResultFilter {
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

fn filtered_ids(store: &ResultStore, result_id: &str, filters: Vec<ResultFilter>) -> Vec<u64> {
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
            vec![ResultFilter {
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
    let size = std::fs::metadata(store.inner.path.as_ref().expect("a file"))
        .expect("file")
        .len();
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
        .as_ref()
        .expect("a file")
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
    let mode = std::fs::metadata(store.inner.path.as_ref().expect("a file"))
        .expect("file")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600, "{mode:o}");
    // SQLite keeps its journal in memory: nothing else appears beside it
    // that could carry different permissions.
    let dir = store
        .inner
        .path
        .as_ref()
        .expect("a file")
        .parent()
        .expect("parent");
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

fn best_of(runs: usize, mut run: impl FnMut()) -> f64 {
    (0..runs)
        .map(|_| {
            let start = Instant::now();
            run();
            ms(start.elapsed())
        })
        .fold(f64::INFINITY, f64::min)
}

/// One line of the view table: what a 200-row window of this order costs
/// with no view (the query, as every read was before views), what the
/// first read costs (it builds the view), and what reads cost after that.
/// "deep" is nine tenths of the way through the view.
fn time_view(
    label: &str,
    store: &ResultStore,
    result_id: &str,
    sort: &[SortKey],
    filters: &[ResultFilter],
) {
    let request = |offset| WindowRequest {
        offset,
        sort: sort.to_vec(),
        filters: filters.to_vec(),
        ..first(200)
    };
    let matching = unmaterialised_ids(store, result_id, sort, filters);
    let deep = matching.len() as u64 * 9 / 10;

    let without_view = |offset: u64| {
        best_of(3, || {
            let mut state = store.inner.lock();
            let meta = lookup(&state, result_id).expect("known");
            let plan = Plan::new(&meta, &ViewKey::new(sort, filters)).expect("plan");
            let conn = state.conn().expect("open");
            read_window(conn, &meta, &plan, Source::Query, &request(offset)).expect("window");
        })
    };
    let (no_view_top, no_view_deep) = (without_view(0), without_view(deep));

    let built_before = store.views_built();
    let start = Instant::now();
    let window = store.window(result_id, &request(0)).expect("window");
    let first_build = ms(start.elapsed());
    assert_eq!(store.views_built(), built_before + 1);
    assert_eq!(window.row_ids, matching[..200]);

    let read_top = best_of(5, || {
        store.window(result_id, &request(0)).expect("window");
    });
    let read_deep = best_of(5, || {
        let window = store.window(result_id, &request(deep)).expect("window");
        assert_eq!(window.row_ids[0], matching[deep as usize]);
    });
    let ids = best_of(5, || {
        store
            .row_ids(result_id, deep, 200, sort, filters)
            .expect("ids");
    });
    let position = best_of(5, || {
        let found = store
            .row_position(result_id, matching[deep as usize], sort, filters)
            .expect("position");
        assert_eq!(found, Some(deep));
    });
    let some: Vec<u64> = matching
        .iter()
        .copied()
        .step_by(matching.len() / 200)
        .collect();
    let order = best_of(5, || {
        store.order(result_id, &some, sort, filters).expect("order");
    });
    assert_eq!(store.views_built(), built_before + 1);
    println!(
        "{label:<26}{no_view_top:10.2}{no_view_deep:10.2}{first_build:10.2}{read_top:10.2}\
         {read_deep:10.2}{ids:10.2}{position:10.3}{order:10.2}"
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

    let file = std::fs::metadata(store.inner.path.as_ref().expect("a file"))
        .expect("file")
        .len();
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
    println!();
    println!(
        "{:<26}{:>10}{:>10}{:>10}{:>10}{:>10}{:>10}{:>10}{:>10}",
        "view (ms)",
        "no view@0",
        "no v.deep",
        "1st build",
        "read@0",
        "read deep",
        "ids 200",
        "position",
        "order 200"
    );
    time_view("sorted by text (name)", &store, id, &[asc(1)], &[]);
    time_view("sorted by DECIMAL desc", &store, id, &[desc(4)], &[]);
    let contains = [filter(6, FilterOperator::Contains, "77")];
    time_view("note contains '77'", &store, id, &[], &contains);
    time_view("contains, sorted by text", &store, id, &[asc(1)], &contains);
    println!(
        "views built                       {:8}",
        store.views_built()
    );

    let ids: Vec<u64> = (1..=1000).map(|n| n * 97).collect();
    let rows_ms = best_of(5, || {
        store.rows(id, &ids).expect("rows");
    });
    println!("1,000 whole rows by id            {rows_ms:8.2} ms");
    let file = std::fs::metadata(store.inner.path.as_ref().expect("a file"))
        .expect("file")
        .len();
    println!(
        "store file with three views       {:8.1} MB",
        file as f64 / 1048576.0
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

// ------------------------------------------------------------------ wire

#[test]
fn binary_crosses_the_wire_as_base64_and_everything_else_as_it_always_did() {
    let (_dir, store) = open_store(16 * MIB);
    let row = vec![
        Null,
        Bool(true),
        Int(-7),
        // Above `i64::MAX`, so that reading the JSON back cannot take it for
        // a signed integer.
        UInt(u64::MAX),
        Float(1.5),
        s("text"),
        Bytes(vec![0, 1, 2, 255]),
        Bytes(Vec::new()),
    ];
    let result = put(
        &store,
        &[
            "INT",
            "BOOLEAN",
            "INT",
            "INT UNSIGNED",
            "DOUBLE",
            "VARCHAR",
            "BLOB",
            "BLOB",
        ],
        std::slice::from_ref(&row),
    );
    let window = store.window(&result.result_id, &first(10)).expect("window");
    let json = serde_json::to_value(&window).expect("serialises");
    let cells: Vec<serde_json::Value> = json["rows"][0]
        .as_array()
        .expect("a row")
        .iter()
        .map(|cell| cell["value"].clone())
        .collect();

    // Every value but binary is the JSON `SqlValue` itself produces.
    for (cell, value) in cells.iter().zip(&row).take(6) {
        assert_eq!(cell, &serde_json::to_value(value).expect("serialises"));
    }
    assert_eq!(cells[6], serde_json::json!({ "bytes": "AAEC/w==" }));
    assert_eq!(cells[7], serde_json::json!({ "bytes": "" }));
    assert_eq!(json["rows"][0][6]["full_len"], serde_json::Value::Null);

    // And it reads back as the window it was.
    let back: ResultWindow = serde_json::from_value(json).expect("deserialises");
    assert_eq!(back, window);

    // `SqlValue` itself still serialises binary as numbers: the old path
    // and the frontend's `isBytes` depend on it.
    assert_eq!(
        serde_json::to_value(Bytes(vec![0, 255])).expect("serialises"),
        serde_json::json!([0, 255])
    );
}

#[test]
fn a_whole_cell_converts_to_its_wire_form() {
    let wire = |value: SqlValue| serde_json::to_value(WireValue::from(value)).expect("serialises");
    assert_eq!(wire(Null), serde_json::Value::Null);
    assert_eq!(wire(Bool(false)), serde_json::json!(false));
    assert_eq!(wire(Int(-1)), serde_json::json!(-1));
    assert_eq!(wire(UInt(u64::MAX)), serde_json::json!(u64::MAX));
    assert_eq!(wire(Float(0.25)), serde_json::json!(0.25));
    assert_eq!(
        wire(s("{\"bytes\": 1}")),
        serde_json::json!("{\"bytes\": 1}")
    );
    assert_eq!(
        wire(Bytes(b"hello".to_vec())),
        serde_json::json!({ "bytes": "aGVsbG8=" })
    );

    for value in [Null, Bool(true), Int(3), s("x"), Bytes(vec![9, 8, 7])] {
        let back: WireValue = serde_json::from_value(wire(value.clone())).expect("deserialises");
        assert_eq!(SqlValue::try_from(back).expect("decodes"), value);
    }
}

#[test]
fn a_truncated_binary_cell_carries_its_real_length() {
    let (_dir, store) = open_store(16 * MIB);
    let result = put(&store, &["BLOB"], &[vec![Bytes(vec![5; 1000])]]);
    let mut request = first(1);
    request.max_cell_bytes = 3;
    let window = store.window(&result.result_id, &request).expect("window");
    let json = serde_json::to_value(&window).expect("serialises");
    assert_eq!(
        json["rows"][0][0],
        serde_json::json!({ "value": { "bytes": "BQUF" }, "full_len": 1000 })
    );
}

// ------------------------------------------------------------- in memory

#[test]
fn a_store_in_memory_works_like_one_in_a_file_and_has_a_budget_too() {
    let store = ResultStore::in_memory(MIB).expect("opens");
    let rows = vec![vec![Int(1), s("one")], vec![Null, Bytes(vec![1, 2, 3])]];
    assert_round_trip(&store, &["INT", "BLOB"], &rows);

    let mut writer = store.begin(&cols(&["VARCHAR"])).expect("begin");
    let batch: Vec<Vec<SqlValue>> = (0..100).map(|_| vec![s(&"x".repeat(4000))]).collect();
    let mut stopped = None;
    for _ in 0..100 {
        if let Err(e) = writer.append(&batch) {
            stopped = Some(e);
            break;
        }
    }
    let err = stopped.expect("the budget stops the write");
    assert!(matches!(err, CoreError::ResultStoreFull(_)), "{err:?}");
    drop(writer);
    assert_eq!(
        store.table_count().expect("count"),
        1,
        "only the finished result is left"
    );
}

// ------------------------------------------------------------------ views

/// The order a view must hold, read the slow way: the sort-and-filter
/// query itself, with no view involved.
fn unmaterialised_ids(
    store: &ResultStore,
    result_id: &str,
    sort: &[SortKey],
    filters: &[ResultFilter],
) -> Vec<u64> {
    let mut state = store.inner.lock();
    let meta = lookup(&state, result_id).expect("known result");
    let plan = Plan::new(&meta, &ViewKey::new(sort, filters)).expect("plan");
    collect_ids(
        state.conn().expect("open"),
        &plan.ordered_ids(meta.table),
        &plan.params,
    )
    .expect("ids")
}

fn window_ids(
    store: &ResultStore,
    result_id: &str,
    offset: u64,
    count: u32,
    sort: &[SortKey],
    filters: &[ResultFilter],
) -> Vec<u64> {
    store
        .window(
            result_id,
            &WindowRequest {
                offset,
                count,
                sort: sort.to_vec(),
                filters: filters.to_vec(),
                max_cell_bytes: 64 * 1024,
            },
        )
        .expect("window")
        .row_ids
}

const OPERATORS: [FilterOperator; 14] = [
    FilterOperator::Contains,
    FilterOperator::NotContains,
    FilterOperator::Equals,
    FilterOperator::NotEquals,
    FilterOperator::StartsWith,
    FilterOperator::EndsWith,
    FilterOperator::Regex,
    FilterOperator::IsNull,
    FilterOperator::IsNotNull,
    FilterOperator::Gt,
    FilterOperator::Gte,
    FilterOperator::Lt,
    FilterOperator::Lte,
    FilterOperator::Between,
];

impl Random {
    fn sort(&mut self, columns: u64) -> Vec<SortKey> {
        (0..self.below(4))
            .map(|_| SortKey {
                column: self.below(columns) as usize,
                descending: self.below(2) == 1,
            })
            .collect()
    }

    fn filters(&mut self, columns: u64) -> Vec<ResultFilter> {
        const OPERANDS: [&str; 8] = ["a", "1", "0", "-1.5", "", "N", "2", "é"];
        (0..self.below(3))
            .map(|_| ResultFilter {
                column: self.below(columns) as usize,
                operator: OPERATORS[self.below(OPERATORS.len() as u64) as usize],
                value: OPERANDS[self.below(OPERANDS.len() as u64) as usize].to_string(),
                value2: (self.below(2) == 1).then(|| "5".to_string()),
            })
            .collect()
    }
}

/// Every read of a view agrees with the query the view was built from.
fn assert_views_match_the_query(store: &ResultStore, seed: u64) {
    let types = ["INT", "VARCHAR", "DECIMAL", "BLOB", "TINYINT(1)", "DOUBLE"];
    let mut random = Random(seed);
    let total = 300_u64;
    let rows: Vec<Vec<SqlValue>> = (0..total)
        .map(|_| types.iter().map(|_| random.value()).collect())
        .collect();
    let stored = put(store, &types, &rows);
    let id = &stored.result_id;

    for round in 0..40 {
        let sort = random.sort(types.len() as u64);
        let filters = random.filters(types.len() as u64);
        let expected = unmaterialised_ids(store, id, &sort, &filters);
        let context = format!("seed {seed} round {round}: {sort:?} {filters:?}");

        let all = store
            .row_ids(id, 0, u32::MAX, &sort, &filters)
            .expect("row ids");
        assert_eq!(all, expected, "{context}");

        // Windows and id ranges at offsets through and past the view.
        for _ in 0..4 {
            let offset = random.below(expected.len() as u64 + 3);
            let count = random.below(60) as u32;
            let from = (offset as usize).min(expected.len());
            let to = (from + count as usize).min(expected.len());
            let window = store
                .window(
                    id,
                    &WindowRequest {
                        offset,
                        count,
                        sort: sort.clone(),
                        filters: filters.clone(),
                        max_cell_bytes: 64 * 1024,
                    },
                )
                .expect("window");
            assert_eq!(window.matching_rows, expected.len() as u64, "{context}");
            assert_eq!(window.row_ids, expected[from..to], "{context}");
            for (row_id, cells) in window.row_ids.iter().zip(&window.rows) {
                for (written, cell) in rows[*row_id as usize - 1].iter().zip(cells) {
                    assert!(same(written, &cell.value), "{context}");
                }
            }
            assert_eq!(
                store
                    .row_ids(id, offset, count, &sort, &filters)
                    .expect("row ids"),
                expected[from..to],
                "{context}"
            );
        }

        // Every row is where the order says, or nowhere.
        for row_id in 0..=total + 1 {
            assert_eq!(
                store
                    .row_position(id, row_id, &sort, &filters)
                    .expect("position"),
                expected
                    .iter()
                    .position(|found| *found == row_id)
                    .map(|p| p as u64),
                "{context} row {row_id}"
            );
        }

        // A few ids and most ids take different routes through `order`.
        for share in [10, 2] {
            let mut asked: Vec<u64> = (0..=total + 2)
                .filter(|_| random.below(share) == 0)
                .collect();
            asked.reverse();
            asked.push(asked.first().copied().unwrap_or(1));
            let ordered = store.order(id, &asked, &sort, &filters).expect("order");
            let wanted: Vec<u64> = expected
                .iter()
                .copied()
                .filter(|found| asked.contains(found))
                .collect();
            assert_eq!(ordered, wanted, "{context}");
        }
    }
    store.release(std::slice::from_ref(id));
}

#[test]
fn every_read_of_a_view_agrees_with_the_query_it_was_built_from() {
    let (_dir, store) = open_store(256 * MIB);
    for seed in [3_u64, 0x9e37_79b9_7f4a_7c15, 77, 0xfeed_f00d] {
        assert_views_match_the_query(&store, seed);
    }
    assert!(store.views_built() > 100, "{}", store.views_built());
    assert_eq!(table_count(&store), 0);

    let in_memory = ResultStore::in_memory(256 * MIB).expect("opens");
    assert_views_match_the_query(&in_memory, 11);
    assert!(in_memory.views_built() > 20);
}

#[test]
fn a_view_is_built_in_many_turns_and_is_still_right() {
    let (_dir, store) = open_store(256 * MIB);
    // More rows than one turn reads or writes, and keys long enough that
    // turns end early on bytes as well.
    let total = 9_500_i64;
    let rows: Vec<Vec<SqlValue>> = (1..=total)
        .map(|n| {
            vec![
                Int((n * 7919) % 1000),
                s(&format!("{:05}{}", (n * 31) % 977, "k".repeat(1500))),
            ]
        })
        .collect();
    let mut writer = store.begin(&cols(&["INT", "VARCHAR"])).expect("begin");
    for batch in rows.chunks(500) {
        writer.append(batch).expect("append");
    }
    let stored = writer.finish().expect("finish");
    let id = &stored.result_id;

    for (sort, filters) in [
        (vec![desc(1), asc(0)], vec![]),
        (vec![asc(0)], vec![filter(1, FilterOperator::Contains, "3")]),
        (vec![], vec![filter(0, FilterOperator::Lt, "500")]),
    ] {
        let expected = unmaterialised_ids(&store, id, &sort, &filters);
        assert!(expected.len() > 2_000, "{}", expected.len());
        let got = store
            .row_ids(id, 0, u32::MAX, &sort, &filters)
            .expect("row ids");
        assert_eq!(got, expected);
    }
    assert_eq!(store.views_built(), 3);
}

#[test]
fn a_view_is_built_once_and_read_many_times() {
    let (_dir, store) = open_store(64 * MIB);
    let stored = put(&store, &["INT", "VARCHAR"], &numbered(500));
    let id = &stored.result_id;

    // The result as it arrived needs no view, however it is read.
    assert_eq!(window_ids(&store, id, 10, 2, &[], &[]), vec![11, 12]);
    assert_eq!(
        store.row_ids(id, 498, 10, &[], &[]).expect("ids"),
        vec![499, 500]
    );
    assert_eq!(
        store.row_position(id, 7, &[], &[]).expect("position"),
        Some(6)
    );
    assert_eq!(
        store.order(id, &[9, 3, 501, 3], &[], &[]).expect("order"),
        vec![3, 9]
    );
    // Nor does a filter with nothing typed into it.
    let idle = [filter(1, FilterOperator::Contains, " ")];
    assert_eq!(window_ids(&store, id, 0, 1, &[], &idle), vec![1]);
    assert_eq!(store.views_built(), 0);
    assert_eq!(table_count(&store), 1);

    let sort = [desc(0)];
    assert_eq!(window_ids(&store, id, 0, 2, &sort, &[]), vec![500, 499]);
    assert_eq!(store.views_built(), 1);
    // Any offset, and every other read, uses the view that is there.
    assert_eq!(window_ids(&store, id, 400, 2, &sort, &[]), vec![100, 99]);
    assert_eq!(
        store.row_ids(id, 498, 5, &sort, &[]).expect("ids"),
        vec![2, 1]
    );
    assert_eq!(
        store.row_position(id, 500, &sort, &[]).expect("position"),
        Some(0)
    );
    assert_eq!(
        store.order(id, &[1, 500, 250], &sort, &[]).expect("order"),
        vec![500, 250, 1]
    );
    // An idle filter beside the sort is the same view.
    assert_eq!(window_ids(&store, id, 0, 1, &sort, &idle), vec![500]);
    assert_eq!(store.views_built(), 1);
    // The result, the view and the view's index.
    assert_eq!(table_count(&store), 3);

    // A different direction is a different view.
    assert_eq!(window_ids(&store, id, 0, 1, &[asc(0)], &[]), vec![1]);
    assert_eq!(store.views_built(), 2);
}

#[test]
fn only_the_most_recent_views_are_kept_and_release_drops_them_all() {
    let (_dir, store) = open_store(64 * MIB);
    let stored = put(&store, &["INT", "VARCHAR"], &numbered(200));
    let other = put(&store, &["INT", "VARCHAR"], &numbered(50));
    let id = &stored.result_id;
    let views: Vec<Vec<SortKey>> = vec![
        vec![desc(0)],
        vec![asc(1)],
        vec![desc(1)],
        vec![asc(1), desc(0)],
    ];
    assert_eq!(VIEWS_PER_RESULT, 3);

    for sort in &views[..3] {
        window_ids(&store, id, 0, 1, sort, &[]);
    }
    assert_eq!(store.views_built(), 3);
    // Two results, three views with an index each.
    assert_eq!(table_count(&store), 2 + 3 * 2);

    // Reading the oldest makes it the newest, so the fourth view pushes
    // out the second, not the first.
    window_ids(&store, id, 0, 1, &views[0], &[]);
    window_ids(&store, id, 0, 1, &views[3], &[]);
    assert_eq!(store.views_built(), 4);
    assert_eq!(table_count(&store), 2 + 3 * 2);
    window_ids(&store, id, 0, 1, &views[0], &[]);
    window_ids(&store, id, 0, 1, &views[2], &[]);
    assert_eq!(store.views_built(), 4, "both were still there");
    assert_eq!(window_ids(&store, id, 0, 1, &views[1], &[]), vec![1]);
    assert_eq!(store.views_built(), 5, "the one pushed out is built again");

    // Another result's views are its own.
    window_ids(&store, &other.result_id, 0, 1, &views[0], &[]);
    assert_eq!(table_count(&store), 2 + 4 * 2);

    store.release(std::slice::from_ref(id));
    assert_eq!(table_count(&store), 1 + 2);
    store.release(&[other.result_id]);
    assert_eq!(table_count(&store), 0);
}

/// Fill the store to the brim with one result of about 1 KB per row.
fn fill_to_the_budget(store: &ResultStore) -> StoredResult {
    let row = |n: i64| vec![Int((n * 7919) % 1000), s(&"x".repeat(1000))];
    let mut writer = store.begin(&cols(&["INT", "TEXT"])).expect("begin");
    let mut n = 0_i64;
    // Coarse, then a row at a time, so that no room is left for anything.
    for size in [100_i64, 1] {
        loop {
            let batch: Vec<Vec<SqlValue>> = (n..n + size).map(row).collect();
            match writer.append(&batch) {
                Ok(()) => n += size,
                Err(CoreError::ResultStoreFull(_)) => break,
                Err(other) => panic!("{other:?}"),
            }
            assert!(n < 100_000, "the budget never stopped the write");
        }
    }
    writer.finish().expect("finish")
}

#[test]
fn a_view_there_is_no_room_for_is_read_without_one() {
    let (dir, store) = open_store(MIB);
    let spare = put(&store, &["INT", "VARCHAR"], &numbered(3000));
    let full = fill_to_the_budget(&store);
    let id = &full.result_id;
    assert!(full.row_count > 300, "{}", full.row_count);
    let tables = table_count(&store);

    for (sort, filters) in [
        (vec![asc(0)], vec![]),
        (vec![], vec![filter(0, FilterOperator::Lt, "500")]),
    ] {
        let expected = unmaterialised_ids(&store, id, &sort, &filters);
        // Twice: the second read knows there is no view and does not try
        // again.
        for _ in 0..2 {
            assert_eq!(
                window_ids(&store, id, 5, 50, &sort, &filters),
                expected[5..55]
            );
        }
        let window = store
            .window(
                id,
                &WindowRequest {
                    sort: sort.clone(),
                    filters: filters.clone(),
                    ..first(1)
                },
            )
            .expect("window");
        assert_eq!(window.matching_rows, expected.len() as u64);
        assert_eq!(
            store
                .row_ids(id, 0, u32::MAX, &sort, &filters)
                .expect("ids"),
            expected
        );
        assert_eq!(
            store
                .row_position(id, expected[40], &sort, &filters)
                .expect("position"),
            Some(40)
        );
        assert_eq!(
            store
                .order(id, &[expected[9], expected[2]], &sort, &filters)
                .expect("order"),
            vec![expected[2], expected[9]]
        );
    }
    assert_eq!(store.views_built(), 0);
    assert_eq!(table_count(&store), tables, "nothing half built is left");
    assert_eq!(store_files(dir.path()).len(), 1, "nor a file to sort in");

    // Room again: the same read now builds its view.
    store.release(&[spare.result_id]);
    let expected = unmaterialised_ids(&store, id, &[asc(0)], &[]);
    assert_eq!(
        window_ids(&store, id, 5, 50, &[asc(0)], &[]),
        expected[5..55]
    );
    assert_eq!(store.views_built(), 1);
}

fn set_build_hook(store: &ResultStore, hook: impl Fn() + Send + Sync + 'static) {
    *store.inner.build_hook.lock().expect("hook") = Some(Arc::new(hook));
}

#[test]
fn two_readers_of_a_new_view_build_it_once() {
    let (_dir, store) = open_store(64 * MIB);
    let store = Arc::new(store);
    let stored = put(&store, &["INT", "VARCHAR"], &numbered(9000));
    // Slow the build down, so that every reader arrives while it runs.
    set_build_hook(&store, || std::thread::sleep(Duration::from_millis(20)));

    let start = Arc::new(std::sync::Barrier::new(6));
    let readers: Vec<_> = (0..6_u64)
        .map(|n| {
            let store = Arc::clone(&store);
            let start = Arc::clone(&start);
            let id = stored.result_id.clone();
            std::thread::spawn(move || {
                start.wait();
                window_ids(&store, &id, n * 1000, 2, &[desc(0)], &[])
            })
        })
        .collect();
    for (n, reader) in readers.into_iter().enumerate() {
        let n = n as u64;
        assert_eq!(
            reader.join().expect("reader"),
            vec![9000 - n * 1000, 8999 - n * 1000]
        );
    }
    assert_eq!(store.views_built(), 1);
    assert_eq!(table_count(&store), 3);
}

thread_local! {
    /// Set on a thread whose view builds a test wants to stop at each turn.
    static STOPS_AT_EACH_TURN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[test]
fn another_result_is_read_while_a_view_is_being_built() {
    use std::sync::mpsc;
    let (_dir, store) = open_store(64 * MIB);
    let store = Arc::new(store);
    let building = put(&store, &["INT", "VARCHAR"], &numbered(9000));
    let other = put(&store, &["INT", "VARCHAR"], &numbered(500));
    // A view of the other result that is already there.
    window_ids(&store, &other.result_id, 0, 1, &[desc(0)], &[]);

    // The build stops after each of its turns until the reader has had
    // one. If a build held the store's lock from start to end, the reader
    // would never answer and the hook would time out.
    let (to_reader, from_builder) = mpsc::channel::<()>();
    let (to_builder, from_reader) = mpsc::channel::<()>();
    let (to_reader, from_reader) = (Mutex::new(to_reader), Mutex::new(from_reader));
    set_build_hook(&store, move || {
        // Only the build under test stops; the reader's own builds run
        // through.
        if !STOPS_AT_EACH_TURN.with(std::cell::Cell::get) {
            return;
        }
        to_reader.lock().expect("lock").send(()).expect("send");
        from_reader
            .lock()
            .expect("lock")
            .recv_timeout(Duration::from_secs(30))
            .expect("the reader was blocked by the build");
    });

    let build_store = Arc::clone(&store);
    let build_id = building.result_id.clone();
    let builder = std::thread::spawn(move || {
        STOPS_AT_EACH_TURN.with(|stops| stops.set(true));
        window_ids(&build_store, &build_id, 0, 3, &[desc(1), asc(0)], &[])
    });

    let mut turns = 0;
    while !builder.is_finished() {
        if from_builder
            .recv_timeout(Duration::from_millis(20))
            .is_err()
        {
            continue;
        }
        turns += 1;
        assert_eq!(
            window_ids(&store, &other.result_id, 100, 2, &[desc(0)], &[]),
            vec![400, 399]
        );
        assert_eq!(
            window_ids(&store, &other.result_id, 100, 2, &[], &[]),
            vec![101, 102]
        );
        if turns == 2 {
            // A new view of the other result is built start to finish
            // while the first build is still half way.
            assert_eq!(
                window_ids(&store, &other.result_id, 0, 2, &[asc(1)], &[]),
                vec![1, 10]
            );
        }
        to_builder.send(()).expect("send");
    }
    // 9,000 rows are read in three turns and written in three.
    assert!(turns >= 4, "the build took {turns} turns");
    // By the text, where "row 999" comes last.
    assert_eq!(builder.join().expect("builder"), vec![999, 998, 997]);
    assert_eq!(store.views_built(), 3);
}

#[test]
fn releasing_a_result_stops_the_build_of_its_view() {
    let (dir, store) = open_store(64 * MIB);
    let store = Arc::new(store);
    let stored = put(&store, &["INT", "VARCHAR"], &numbered(9000));
    let kept = put(&store, &["INT"], &[vec![Int(1)]]);

    // Release the result from inside its own view's build, after the
    // second turn.
    let weak = Arc::downgrade(&store);
    let id = stored.result_id.clone();
    let turns = std::sync::atomic::AtomicU64::new(0);
    set_build_hook(&store, move || {
        if turns.fetch_add(1, Ordering::Relaxed) == 1 {
            if let Some(store) = weak.upgrade() {
                store.release(std::slice::from_ref(&id));
            }
        }
    });

    for (sort, filters) in [
        (vec![desc(1)], vec![]),
        (vec![], vec![filter(0, FilterOperator::Gt, "5")]),
    ] {
        let err = store
            .window(
                &stored.result_id,
                &WindowRequest {
                    sort,
                    filters,
                    ..first(3)
                },
            )
            .expect_err("released under the read");
        assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
    }
    assert_eq!(store.views_built(), 0);
    assert_eq!(table_count(&store), 1, "only the other result is left");
    assert_eq!(store_files(dir.path()).len(), 1);
    assert_eq!(window_ids(&store, &kept.result_id, 0, 5, &[], &[]), vec![1]);
}

// ---------------------------------------------------- ids, positions, rows

#[test]
fn a_result_the_store_does_not_hold_is_not_found_by_any_read() {
    let (_dir, store) = open_store(64 * MIB);
    // What a handle with no rows carries: an id the store never saw.
    let id = "a-handle-with-no-rows";
    let sort = [asc(0)];
    let not_found = |err: CoreError| assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");

    not_found(store.row_ids(id, 0, 10, &[], &[]).expect_err("ids"));
    not_found(store.row_ids(id, 0, 10, &sort, &[]).expect_err("ids"));
    not_found(store.row_ids(id, 0, 0, &[], &[]).expect_err("ids"));
    not_found(store.row_position(id, 1, &[], &[]).expect_err("position"));
    not_found(store.row_position(id, 1, &sort, &[]).expect_err("position"));
    not_found(store.order(id, &[1], &[], &[]).expect_err("order"));
    not_found(store.order(id, &[], &sort, &[]).expect_err("order"));
    not_found(store.rows(id, &[1]).expect_err("rows"));
    not_found(store.rows(id, &[]).expect_err("rows"));

    // A released result is the same.
    let stored = put(&store, &["INT"], &[vec![Int(1)]]);
    store.release(std::slice::from_ref(&stored.result_id));
    not_found(
        store
            .row_ids(&stored.result_id, 0, 1, &[], &[])
            .expect_err("ids"),
    );
    not_found(store.rows(&stored.result_id, &[1]).expect_err("rows"));
}

#[test]
fn row_ids_are_clamped_to_the_view_and_to_the_cap() {
    let (_dir, store) = open_store(256 * MIB);
    let stored = put(&store, &["INT", "VARCHAR"], &numbered(250));
    let id = &stored.result_id;
    let even = [filter(1, FilterOperator::EndsWith, "0")];
    let sort = [desc(0)];

    for (sort, filters, all) in [
        (&[][..], &[][..], (1..=250).collect::<Vec<u64>>()),
        (&sort[..], &[][..], (1..=250).rev().collect()),
        (&[][..], &even[..], (1..=25).map(|n| n * 10).collect()),
    ] {
        let len = all.len() as u64;
        let ids = |offset, count| {
            store
                .row_ids(id, offset, count, sort, filters)
                .expect("ids")
        };
        assert_eq!(ids(0, u32::MAX), all);
        assert_eq!(ids(3, 2), all[3..5]);
        assert_eq!(ids(len - 2, 10), all[all.len() - 2..]);
        assert_eq!(ids(len, 10), Vec::<u64>::new());
        assert_eq!(ids(u64::MAX, 10), Vec::<u64>::new());
        assert_eq!(ids(0, 0), Vec::<u64>::new());
    }

    // A sort on a column the result lacks is refused, as a window's is.
    let err = store.row_ids(id, 0, 1, &[asc(9)], &[]).expect_err("column");
    assert!(matches!(err, CoreError::Query(_)), "{err:?}");
    let err = store
        .row_position(id, 1, &[], &[filter(9, FilterOperator::IsNull, "")])
        .expect_err("column");
    assert!(matches!(err, CoreError::Query(_)), "{err:?}");

    // More rows than the cap: one call stops at the cap, sorted or not.
    let total = u64::from(ROW_IDS_MAX_COUNT) + 500;
    let mut writer = store.begin(&cols(&["INT"])).expect("begin");
    let rows: Vec<Vec<SqlValue>> = (1..=total as i64).map(|n| vec![Int(n)]).collect();
    for batch in rows.chunks(10_000) {
        writer.append(batch).expect("append");
    }
    let big = writer.finish().expect("finish");
    for sort in [&[][..], &sort[..]] {
        let capped = store
            .row_ids(&big.result_id, 0, u32::MAX, sort, &[])
            .expect("ids");
        assert_eq!(capped.len(), ROW_IDS_MAX_COUNT as usize);
        let rest = store
            .row_ids(&big.result_id, capped.len() as u64, u32::MAX, sort, &[])
            .expect("ids");
        assert_eq!(rest.len(), 500);
    }
}

#[test]
fn a_row_has_a_position_only_where_the_view_has_the_row() {
    let (_dir, store) = open_store(64 * MIB);
    let stored = put(&store, &["INT", "VARCHAR"], &numbered(100));
    let id = &stored.result_id;
    let tens = [filter(1, FilterOperator::EndsWith, "0")];
    let sort = [desc(0)];
    let position = |row, sort: &[SortKey], filters: &[ResultFilter]| {
        store
            .row_position(id, row, sort, filters)
            .expect("position")
    };

    assert_eq!(position(1, &[], &[]), Some(0));
    assert_eq!(position(100, &[], &[]), Some(99));
    assert_eq!(position(100, &sort, &[]), Some(0));
    assert_eq!(position(30, &[], &tens), Some(2));
    assert_eq!(position(30, &sort, &tens), Some(7));
    // Filtered out.
    assert_eq!(position(31, &[], &tens), None);
    assert_eq!(position(31, &sort, &tens), None);
    // Not rows of the result at all.
    for (sort, filters) in [(&[][..], &[][..]), (&sort[..], &tens[..])] {
        assert_eq!(position(0, sort, filters), None);
        assert_eq!(position(101, sort, filters), None);
        assert_eq!(position(u64::MAX, sort, filters), None);
    }
}

#[test]
fn order_keeps_the_ids_in_the_view_and_refuses_too_many() {
    let (_dir, store) = open_store(64 * MIB);
    let stored = put(&store, &["INT", "VARCHAR"], &numbered(100));
    let id = &stored.result_id;
    let tens = [filter(1, FilterOperator::EndsWith, "0")];
    let sort = [desc(0)];

    let asked = [5, 90, 20, 0, 101, 20, 7, 50, u64::MAX];
    assert_eq!(
        store.order(id, &asked, &[], &[]).expect("order"),
        vec![5, 7, 20, 50, 90]
    );
    assert_eq!(
        store.order(id, &asked, &sort, &[]).expect("order"),
        vec![90, 50, 20, 7, 5]
    );
    assert_eq!(
        store.order(id, &asked, &sort, &tens).expect("order"),
        vec![90, 50, 20]
    );
    assert_eq!(
        store.order(id, &[], &sort, &tens).expect("order"),
        Vec::<u64>::new()
    );
    // Everything, which walks the view instead of looking each id up.
    let all: Vec<u64> = (1..=100).collect();
    assert_eq!(
        store.order(id, &all, &sort, &[]).expect("order"),
        (1..=100).rev().collect::<Vec<u64>>()
    );

    let too_many = vec![1_u64; ORDER_MAX_IDS + 1];
    let err = store.order(id, &too_many, &[], &[]).expect_err("too many");
    assert!(matches!(err, CoreError::Query(_)), "{err:?}");
}

#[test]
fn order_works_through_a_long_list_in_turns() {
    let (_dir, store) = open_store(256 * MIB);
    let total = 60_000_u64;
    let mut writer = store.begin(&cols(&["INT"])).expect("begin");
    let rows: Vec<Vec<SqlValue>> = (1..=total as i64).map(|n| vec![Int(n)]).collect();
    for batch in rows.chunks(10_000) {
        writer.append(batch).expect("append");
    }
    let stored = writer.finish().expect("finish");
    let sort = [desc(0)];

    // Looked up: fewer than a quarter of the view, more than one turn.
    let some: Vec<u64> = (1..=total).filter(|n| n % 5 == 0).collect();
    assert!(some.len() > ORDER_SEEKS_PER_TURN * 2);
    let ordered = store
        .order(&stored.result_id, &some, &sort, &[])
        .expect("order");
    assert_eq!(ordered, some.iter().rev().copied().collect::<Vec<_>>());

    // Walked: most of the view, more than one turn.
    let most: Vec<u64> = (1..=total).filter(|n| n % 3 != 0).collect();
    assert!(total > u64::from(ORDER_SCAN_PER_TURN) * 2);
    let ordered = store
        .order(&stored.result_id, &most, &sort, &[])
        .expect("order");
    assert_eq!(ordered, most.iter().rev().copied().collect::<Vec<_>>());
    assert_eq!(store.views_built(), 1);
}

#[test]
fn rows_come_back_whole_in_the_order_asked() {
    let (_dir, store) = open_store(64 * MIB);
    let long = "é".repeat(100_000);
    let blob: Vec<u8> = (0..200_000_u32).map(|n| n as u8).collect();
    let rows = vec![
        vec![Int(1), s("one"), Bytes(vec![1])],
        vec![Int(2), s(&long), Bytes(blob.clone())],
        // Cells that are not what their columns' cells are.
        vec![Bool(true), UInt(u64::MAX), Null],
        vec![Int(4), s("four"), Float(f64::NAN)],
    ];
    let stored = put(&store, &["INT", "VARCHAR", "BLOB"], &rows);
    let id = &stored.result_id;

    let got = store.rows(id, &[4, 2, 2, 1, 3]).expect("rows");
    assert_eq!(got.len(), 5);
    for (read, written) in got.iter().zip([3, 1, 1, 0, 2]) {
        for (value, expected) in read.iter().zip(&rows[written]) {
            assert!(same(expected, value));
        }
    }
    // A window would have cut these; `rows` does not.
    assert_eq!(got[1][1], s(&long));
    assert_eq!(got[1][2], Bytes(blob));
    assert_eq!(
        store.rows(id, &[]).expect("rows"),
        Vec::<Vec<SqlValue>>::new()
    );

    for missing in [0, 5, u64::MAX] {
        let err = store.rows(id, &[1, missing]).expect_err("no such row");
        assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
    }
}

#[test]
fn rows_are_capped_by_count_and_by_bytes() {
    let (_dir, store) = open_store(512 * MIB);
    let many = put(&store, &["INT", "VARCHAR"], &numbered(1500));
    let ids: Vec<u64> = (1..=ROWS_MAX_COUNT as u64 + 1).collect();
    // Exactly the cap is fine, in several turns at the lock.
    let got = store
        .rows(&many.result_id, &ids[..ROWS_MAX_COUNT])
        .expect("rows");
    assert_eq!(got.len(), ROWS_MAX_COUNT);
    assert_eq!(got[999], vec![Int(1000), s("row 1000")]);
    let err = store.rows(&many.result_id, &ids).expect_err("too many");
    assert!(
        matches!(&err, CoreError::Query(m) if m.contains("1000")),
        "{err:?}"
    );

    // Three rows of 30 MiB: two fit in 64 MiB, the third does not.
    let big = (ROWS_MAX_BYTES / 64 * 30) as usize;
    let mut writer = store.begin(&cols(&["LONGBLOB"])).expect("begin");
    for n in 0..3_u8 {
        writer.append(&[vec![Bytes(vec![n; big])]]).expect("append");
    }
    let large = writer.finish().expect("finish");
    assert_eq!(
        store.rows(&large.result_id, &[1, 3]).expect("rows").len(),
        2
    );
    let err = store
        .rows(&large.result_id, &[1, 2, 3])
        .expect_err("past the byte cap");
    match &err {
        CoreError::Query(message) => {
            assert!(message.starts_with(ROWS_TOO_LARGE), "{message}");
            assert!(message.contains("fewer rows"), "{message}");
        }
        other => panic!("{other:?}"),
    }

    // One row is returned whatever its size: there is nothing smaller to
    // ask for.
    let huge = (ROWS_MAX_BYTES + 1024) as usize;
    let mut writer = store.begin(&cols(&["LONGBLOB"])).expect("begin");
    writer
        .append(&[vec![Bytes(vec![7; huge])]])
        .expect("append");
    let one = writer.finish().expect("finish");
    let got = store.rows(&one.result_id, &[1]).expect("one row");
    assert!(matches!(&got[0][0], Bytes(bytes) if bytes.len() == huge));
    let err = store
        .rows(&one.result_id, &[1, 1])
        .expect_err("twice is not");
    assert!(
        matches!(&err, CoreError::Query(m) if m.starts_with(ROWS_TOO_LARGE)),
        "{err:?}"
    );
}

// ------------------------------------------------------------ wide results

#[test]
fn a_result_as_wide_as_a_mysql_table_is_stored_sorted_and_filtered() {
    const WIDTH: usize = 4096;
    let (_dir, store) = open_store(256 * MIB);
    // What the SQLite in this binary allows, not what the build was asked
    // for: this fails if `LIBSQLITE3_FLAGS` did not reach the build.
    assert!(
        store.max_columns() >= WIDTH,
        "the bundled SQLite allows {} columns; see src-tauri/.cargo/config.toml",
        store.max_columns()
    );

    // Integers in the even columns and text in the odd ones, different in
    // every row, so a value read from the wrong column or row shows.
    let types: Vec<&str> = (0..WIDTH)
        .map(|c| if c % 2 == 0 { "INT" } else { "VARCHAR" })
        .collect();
    let cell = |row: usize, column: usize| {
        let n = (row * 37 + column * 11) % 101;
        if column.is_multiple_of(2) {
            Int(n as i64)
        } else {
            s(&format!("v{n:03}-{row}-{column}"))
        }
    };
    let rows: Vec<Vec<SqlValue>> = (0..30)
        .map(|row| (0..WIDTH).map(|column| cell(row, column)).collect())
        .collect();
    let mut writer = store.begin(&cols(&types)).expect("begin");
    for batch in rows.chunks(7) {
        writer.append(batch).expect("append");
    }
    let stored = writer.finish().expect("finish");
    let id = &stored.result_id;

    // Every cell of every row, through a window and through `rows`.
    let window = store.window(id, &first(100)).expect("window");
    assert_eq!(values(&window), rows);
    let got = store.rows(id, &[30, 1, 17]).expect("rows");
    assert_eq!(
        got,
        vec![rows[29].clone(), rows[0].clone(), rows[16].clone()]
    );
    assert_eq!(store.cell(id, 12, 4095).expect("cell"), cell(11, 4095));

    // Sort and filter on columns past SQLite's stock 2,000.
    let by = |column: usize| {
        let mut order: Vec<usize> = (0..rows.len()).collect();
        order.sort_by(|a, b| {
            let key = |row: usize| match &rows[row][column] {
                Int(n) => (*n, String::new()),
                Str(text) => (0, text.clone()),
                _ => unreachable!(),
            };
            key(*a).cmp(&key(*b)).then(a.cmp(b))
        });
        order
            .into_iter()
            .map(|row| row as u64 + 1)
            .collect::<Vec<_>>()
    };
    for column in [2500, 4094, 3001, 4095] {
        let mut expected = by(column);
        assert_eq!(
            store.row_ids(id, 0, 100, &[asc(column)], &[]).expect("ids"),
            expected,
            "column {column}"
        );
        assert_eq!(
            unmaterialised_ids(&store, id, &[asc(column)], &[]),
            expected
        );
        // Descending with the arrival order still breaking ties.
        expected.sort_by(|a, b| {
            let value = |id: &u64| rows[*id as usize - 1][column].clone();
            match (value(a), value(b)) {
                (Int(x), Int(y)) => y.cmp(&x),
                (Str(x), Str(y)) => y.cmp(&x),
                _ => unreachable!(),
            }
            .then(a.cmp(b))
        });
        let window = store
            .window(
                id,
                &WindowRequest {
                    offset: 3,
                    sort: vec![desc(column)],
                    ..first(5)
                },
            )
            .expect("sorted window");
        assert_eq!(window.row_ids, expected[3..8], "column {column}");
        assert_eq!(
            window.rows[0][column].value,
            rows[expected[3] as usize - 1][column]
        );
    }

    let wanted = match cell(4, 3999) {
        Str(text) => text,
        _ => unreachable!(),
    };
    let only = [filter(3999, FilterOperator::Equals, &wanted)];
    let window = store
        .window(
            id,
            &WindowRequest {
                filters: only.to_vec(),
                sort: vec![desc(2048)],
                ..first(10)
            },
        )
        .expect("filtered window");
    assert_eq!(window.matching_rows, 1);
    assert_eq!(window.row_ids, vec![5]);
    assert_eq!(values(&window), vec![rows[4].clone()]);
    assert_eq!(
        store.row_position(id, 5, &[], &only).expect("position"),
        Some(0)
    );
    let small = [filter(4000, FilterOperator::Lt, "20")];
    let expected: Vec<u64> = (0..rows.len())
        .filter(|row| matches!(rows[*row][4000], Int(n) if n < 20))
        .map(|row| row as u64 + 1)
        .collect();
    assert!(!expected.is_empty());
    assert_eq!(
        store.row_ids(id, 0, 100, &[], &small).expect("ids"),
        expected
    );

    // A cell limit below every text value makes the window select two
    // values for each of the 2,048 text columns: the widest query there is.
    let cut = store
        .window(
            id,
            &WindowRequest {
                max_cell_bytes: 4,
                ..first(2)
            },
        )
        .expect("cut window");
    let Str(whole) = &rows[1][4095] else {
        unreachable!()
    };
    assert_eq!(cut.rows[1][4095].value, s(&whole[..4]));
    assert!(cut.rows[1][4095].full_len.is_some());
    assert_eq!(cut.rows[1][4094].value, rows[1][4094]);
}

#[test]
fn a_result_wider_than_the_store_allows_is_refused_with_the_limit() {
    let (_dir, store) = open_store(64 * MIB);
    let too_wide = vec!["INT"; store.max_columns() + 1];
    let err = match store.begin(&cols(&too_wide)) {
        Ok(_) => panic!("accepted"),
        Err(e) => e,
    };
    match &err {
        CoreError::Storage(message) => {
            assert!(
                message.contains(&store.max_columns().to_string()),
                "{message}"
            );
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(table_count(&store), 0);
}
