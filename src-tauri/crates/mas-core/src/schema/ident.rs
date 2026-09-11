/// Quote an identifier for interpolation into a statement.
///
/// A backtick inside a name is escaped by doubling it, which is what MySQL
/// does in its own `SHOW CREATE` output. Without this, a database called
/// ``a`b`` closes the quote early and the rest of the name becomes syntax —
/// or, with a name chosen for the purpose, becomes a second statement.
///
/// Identifiers reaching the inspector come from the schema itself rather than
/// from a text box, so this is a second line rather than the first. It is
/// still the line that has to hold: a table can be named anything, and a name
/// this app read back from `information_schema` is not thereby safe to splice
/// into SQL unescaped.
pub fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// `` `db`.`name` `` — a reference that needs no `USE` to resolve.
///
/// The DDL reads used to run `USE <database>` and then an unqualified `SHOW
/// CREATE`, as two statements against a pool. With `pool_max > 1` the second
/// is not guaranteed to land on the session the first one changed, so it
/// either failed with "no database selected" or returned the object of that
/// name from whichever database that connection happened to be pointing at —
/// silently, and only sometimes (#290).
pub fn qualified(database: &str, name: &str) -> String {
    format!("{}.{}", quote_ident(database), quote_ident(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_a_plain_name() {
        assert_eq!(quote_ident("users"), "`users`");
    }

    #[test]
    fn doubles_a_backtick() {
        // Otherwise the quote closes early and the rest of the name becomes
        // syntax.
        assert_eq!(quote_ident("a`b"), "`a``b`");
    }

    #[test]
    fn survives_a_name_built_to_break_out() {
        assert_eq!(
            quote_ident("x`; DROP TABLE users; --"),
            "`x``; DROP TABLE users; --`"
        );
    }

    #[test]
    fn leaves_other_punctuation_alone() {
        // Only the backtick is special inside a backtick-quoted identifier.
        assert_eq!(quote_ident("order details"), "`order details`");
        assert_eq!(quote_ident("a'b\"c"), "`a'b\"c`");
    }

    #[test]
    fn qualifies_both_halves() {
        assert_eq!(qualified("shop", "orders"), "`shop`.`orders`");
        assert_eq!(qualified("a`b", "c`d"), "`a``b`.`c``d`");
    }
}
