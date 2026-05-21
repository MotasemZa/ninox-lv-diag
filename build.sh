#!/bin/bash
set -e

echo "Building Ninox Diagnostics for macOS..."

# Install PyInstaller if not already installed
/usr/bin/python3 -m pip install pyinstaller

# Run PyInstaller
# --noconfirm: overwrite existing build
# --windowed: create a macOS .app bundle, no terminal console
# --name: the name of the app
# --add-data: include the static folder and playbooks.yaml

/usr/bin/python3 -m PyInstaller --noconfirm \
    --clean \
    --windowed \
    --onedir \
    --name "Ninox Diagnostics" \
    --osx-bundle-identifier "com.ninox.lvdiag" \
    --add-data "static:static" \
    --add-data "playbooks.yaml:." \
    --hidden-import "uvicorn" \
    --hidden-import "fastapi" \
    --hidden-import "pywebview" \
    --hidden-import "webview" \
    --hidden-import "requests" \
    main.py

echo "Build complete! Check the 'dist' folder for Ninox Diagnostics.app"
echo "You can zip this file and upload it to GitHub Releases."
