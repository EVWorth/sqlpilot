#!/bin/bash
# Generate test SSL certificates for MySQL testing
# These are for LOCAL TESTING ONLY - never use in production

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Generating CA certificate..."
openssl genrsa 2048 > ca-key.pem
openssl req -new -x509 -nodes -days 3650 -key ca-key.pem -out ca-cert.pem \
    -subj "/CN=MySQL Test CA/O=SQLPilot/C=US"

echo "Generating server certificate..."
openssl req -newkey rsa:2048 -nodes -keyout server-key.pem -out server-req.pem \
    -subj "/CN=mysql-ssl/O=SQLPilot/C=US"
openssl x509 -req -in server-req.pem -days 3650 -CA ca-cert.pem -CAkey ca-key.pem \
    -set_serial 01 -out server-cert.pem

echo "Generating client certificate..."
openssl req -newkey rsa:2048 -nodes -keyout client-key.pem -out client-req.pem \
    -subj "/CN=mysql-client/O=SQLPilot/C=US"
openssl x509 -req -in client-req.pem -days 3650 -CA ca-cert.pem -CAkey ca-key.pem \
    -set_serial 02 -out client-cert.pem

# Clean up CSR files
rm -f server-req.pem client-req.pem

echo "Verifying certificates..."
openssl verify -CAfile ca-cert.pem server-cert.pem
openssl verify -CAfile ca-cert.pem client-cert.pem

echo "SSL certificates generated successfully in $SCRIPT_DIR"
