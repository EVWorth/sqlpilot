.PHONY: dev build test test-rust test-frontend test-e2e lint fmt clean db-up db-down db-seed db-reset ssl-certs

# Development
dev:
	npm run tauri dev

build:
	npm run tauri build

# Testing
test: test-rust test-frontend

test-rust:
	cd src-tauri && cargo test --all --verbose

test-frontend:
	npm run test:unit

test-e2e: db-up
	npm run test:e2e

# Linting & Formatting
lint:
	cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings
	npm run lint
	npm run type-check

fmt:
	cd src-tauri && cargo fmt --all
	npm run format

# Database Management
db-up:
	docker compose -f docker-compose.test.yml up -d
	@echo "Waiting for databases to be ready..."
	@until docker exec mas-mysql-8 mysqladmin ping -h localhost -u root -ptest_root_password 2>/dev/null; do sleep 2; done
	@echo "MySQL 8 ready"
	@until docker exec mas-mysql-57 mysqladmin ping -h localhost -u root -ptest_root_password 2>/dev/null; do sleep 2; done
	@echo "MySQL 5.7 ready"
	@echo "All databases ready!"

db-down:
	docker compose -f docker-compose.test.yml down -v

db-reset: db-down db-up

db-seed:
	docker exec -i mas-mysql-8 mysql -u root -ptest_root_password < tests/fixtures/sql/seed.sql

# SSL Certificates (for testing)
ssl-certs:
	cd tests/fixtures/ssl && bash generate-certs.sh

# Cleanup
clean:
	cd src-tauri && cargo clean
	rm -rf node_modules dist coverage playwright-report test-results
