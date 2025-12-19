#!/bin/bash
# Start the NetSuite Excel Formulas backend server

cd "$(dirname "$0")"

echo "Starting NetSuite Excel Formulas backend server..."
echo "Press Ctrl+C to stop"
echo ""

python3 server.py

