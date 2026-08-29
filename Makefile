# Deprecated — tasks live in the justfile now.
#
# Kept for one release cycle so `make test` and friends keep working for
# anyone with the old habits, and so any external doc pointing at `make`
# still lands somewhere useful. Every target forwards to `just`.
#
# Run `just` with no arguments to see the real list, which includes tasks
# this file never had.

JUST := $(shell command -v just 2> /dev/null)

# Forward any target to just, including ones added since. `bump` takes its
# level as an argument now (`just bump minor`) rather than BUMP_TYPE=minor.
.DEFAULT_GOAL := help
.PHONY: help
help:
	@echo "The Makefile is deprecated — this project uses just."
	@echo
	@echo "  mise install     get Node, Rust and just"
	@echo "  just             list every task"
	@echo
	@echo "Forwarding still works: 'make test' runs 'just test'."

%:
	@if [ -z "$(JUST)" ]; then \
		echo "just is not installed. Run 'mise install' (or see https://just.systems)." >&2; \
		exit 1; \
	fi
	@echo "note: 'make $@' is deprecated, use 'just $@'" >&2
	@just $@
