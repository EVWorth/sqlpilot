.PHONY: dev dev-web build test test-rust test-integration test-frontend test-browser bindings lint fmt clean db-up db-down db-seed db-reset ssl-certs setup

# Quick setup — system deps, toolchains via mise, npm, git hooks, Playwright.
# Single implementation lives in the script so there is one setup path, not two.
setup:
	./scripts/setup.sh

# Development
dev:
	npx tauri dev

dev-web:
	npx vite --host

build:
	npx tauri build

# Testing
test: test-rust test-frontend

# Unit tests only — no database required. Mirrors what CI runs per PR.
test-rust:
	cd src-tauri && cargo test -p mas-core -p mas-export -p mas-admin -p mas-sqlite --verbose

# The tests that need a live server. They are #[ignore]d so the default run
# stays container-free; CI runs these only at release time, so this is the way
# to exercise them before pushing. Needs `make db-up` first.
test-integration:
	cd src-tauri && cargo test -p mas-core -p mas-admin -- --ignored

test-frontend:
	npx vitest run

test-browser:
	npm run test:browser

# Regenerate src/lib/bindings.ts from the Rust command definitions.
# --features beta-ai so the AI commands are present in the output.
bindings:
	cd src-tauri && cargo test --features beta-ai --test export_bindings

test-all: db-up test test-integration

# Linting & Formatting
lint:
	cd src-tauri && cargo clippy -p mas-core -p mas-export -p mas-admin -- -D warnings
	npx tsc --noEmit
	npx dprint check

fmt:
	cd src-tauri && cargo fmt --all
	npx dprint fmt

# Database Management (works with or without docker compose)
#
# Bind mounts carry :z so the seed files are relabelled for SELinux hosts
# (Fedora and friends) — without it the container cannot read them and the
# database comes up empty, or in MariaDB's case fails to start at all.
db-up:
	@if command -v docker compose >/dev/null 2>&1; then \
		docker compose -f docker-compose.test.yml up -d mysql-8 mariadb-11; \
	elif command -v docker-compose >/dev/null 2>&1; then \
		docker-compose -f docker-compose.test.yml up -d mysql-8 mariadb-11; \
	else \
		echo "Starting containers directly..."; \
		docker run -d --name mas-mysql-8 \
			-e MYSQL_ROOT_PASSWORD=test_root_password \
			-e MYSQL_DATABASE=test_db \
			-e MYSQL_USER=test_user \
			-e MYSQL_PASSWORD=test_password \
			-p 13306:3306 \
			-v $$(pwd)/tests/fixtures/sql/seed.sql:/docker-entrypoint-initdb.d/01-seed.sql:ro,z \
			mysql:8.0 \
			--default-authentication-plugin=mysql_native_password \
			--character-set-server=utf8mb4 \
			--collation-server=utf8mb4_unicode_ci; \
		docker run -d --name mas-mariadb-11 \
			-e MYSQL_ROOT_PASSWORD=test_root_password \
			-e MYSQL_DATABASE=test_db \
			-e MYSQL_USER=test_user \
			-e MYSQL_PASSWORD=test_password \
			-p 13308:3306 \
			-v $$(pwd)/tests/fixtures/sql/seed.sql:/docker-entrypoint-initdb.d/01-seed.sql:ro,z \
			mariadb:11; \
	fi
	@# Wait on the container health status, not a bare ping. While the seed
	@# scripts run, MySQL serves a temporary local-only server and then
	@# restarts — a ping answers during that window, so anything that connects
	@# on the strength of it is met with an EOF moments later.
	@for name in mas-mysql-8 mas-mariadb-11; do \
		echo "Waiting for $$name to be ready..."; \
		ok=""; \
		for i in $$(seq 1 90); do \
			status=$$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $$name 2>/dev/null); \
			if [ "$$status" = "healthy" ]; then ok=1; break; fi; \
			if [ "$$status" = "none" ]; then \
				docker exec $$name sh -c 'mariadb-admin ping -h127.0.0.1 -uroot -ptest_root_password 2>/dev/null || mysqladmin ping -h127.0.0.1 -uroot -ptest_root_password 2>/dev/null' >/dev/null 2>&1 && ok=1 && break; \
			fi; \
			sleep 2; \
		done; \
		if [ -z "$$ok" ]; then echo "$$name did not become ready"; exit 1; fi; \
	done
	@echo "MySQL 8 ready on 13306, MariaDB 11 on 13308!"

db-down:
	@docker rm -f mas-mysql-8 2>/dev/null || true
	@docker rm -f mas-mariadb-11 2>/dev/null || true

db-seed:
	docker exec -i mas-mysql-8 mysql -u root -ptest_root_password < tests/fixtures/sql/seed.sql
	docker exec -i mas-mariadb-11 mariadb -u root -ptest_root_password < tests/fixtures/sql/seed.sql

db-reset: db-down db-up

# SSL Certificates (for testing)
ssl-certs:
	cd tests/fixtures/ssl && bash generate-certs.sh

# Version bumping
BUMP_TYPE ?= patch

bump:
	@current=$$(node -p "require('./package.json').version"); \
	echo "Current version: $$current"; \
	new=$$(node -e "const v='$$current'.split('.').map(Number); \
		if ('$(BUMP_TYPE)' == 'major') { v[0]+=1; v[1]=0; v[2]=0; } \
		else if ('$(BUMP_TYPE)' == 'minor') { v[1]+=1; v[2]=0; } \
		else { v[2]+=1; } \
		console.log(v.join('.'));"); \
	echo "New version: $$new"; \
	read -p "Proceed? [Y/n] " -n 1 -r; echo; \
	if [[ $$REPLY =~ ^[Yy]$$ ]] || [[ -z $$REPLY ]]; then \
		node -e "const fs=require('fs'); \
			const p=JSON.parse(fs.readFileSync('package.json','utf8')); \
			p.version='$$new'; \
			fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');"; \
		node -e "const fs=require('fs'); \
			const t=JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8')); \
			t.version='$$new'; \
			fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t,null,2)+'\n');"; \
		sed -i "s/^version = \".*\"/version = \"$$new\"/" src-tauri/Cargo.toml; \
		echo "Version bumped to $$new in all files."; \
		echo "Run: git add -A && git commit -m \"chore: bump version to $$new\" && git tag v$$new"; \
	else \
		echo "Cancelled."; \
	fi

# Cleanup
clean:
	cd src-tauri && cargo clean
	rm -rf dist coverage playwright-report test-results
