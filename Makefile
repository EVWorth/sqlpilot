.PHONY: dev dev-web build test test-rust test-frontend test-e2e lint fmt clean db-up db-down db-seed db-reset ssl-certs setup

# Quick setup (install system deps + npm + check rust)
setup:
	@echo "Installing Tauri system dependencies (requires sudo)..."
	sudo apt install -y pkg-config libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libssl-dev
	@echo "Installing npm dependencies..."
	npm install
	@echo "Checking Rust toolchain..."
	rustup show
	@echo "Setup complete! Run 'make dev' for desktop app or 'make dev-web' for browser preview."

# Development
dev:
	npx tauri dev

dev-web:
	npx vite --host

build:
	npx tauri build

# Testing
test: test-rust test-frontend

test-rust:
	cd src-tauri && cargo test -p mas-core -p mas-export -p mas-admin --verbose

test-frontend:
	npx vitest run

test-e2e: db-up
	npx playwright test

test-all: db-up test

# Linting & Formatting
lint:
	cd src-tauri && cargo clippy -p mas-core -p mas-export -p mas-admin -- -D warnings
	npx tsc --noEmit

fmt:
	cd src-tauri && cargo fmt --all

# Database Management (works with or without docker compose)
db-up:
	@if command -v docker compose >/dev/null 2>&1; then \
		docker compose -f docker-compose.test.yml up -d mysql-8; \
	elif command -v docker-compose >/dev/null 2>&1; then \
		docker-compose -f docker-compose.test.yml up -d mysql-8; \
	else \
		echo "Starting MySQL 8 container directly..."; \
		docker run -d --name mas-mysql-8 \
			-e MYSQL_ROOT_PASSWORD=test_root_password \
			-e MYSQL_DATABASE=test_db \
			-e MYSQL_USER=test_user \
			-e MYSQL_PASSWORD=test_password \
			-p 13306:3306 \
			-v $$(pwd)/tests/fixtures/sql/seed.sql:/docker-entrypoint-initdb.d/01-seed.sql \
			mysql:8.0 \
			--default-authentication-plugin=mysql_native_password \
			--character-set-server=utf8mb4 \
			--collation-server=utf8mb4_unicode_ci; \
	fi
	@echo "Waiting for MySQL 8 to be ready..."
	@for i in $$(seq 1 60); do \
		docker exec mas-mysql-8 mysqladmin ping -h localhost -u root -ptest_root_password 2>/dev/null && break; \
		sleep 2; \
	done
	@echo "MySQL 8 ready on port 13306!"

db-down:
	@docker rm -f mas-mysql-8 2>/dev/null || true

db-seed:
	docker exec -i mas-mysql-8 mysql -u root -ptest_root_password < tests/fixtures/sql/seed.sql

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
