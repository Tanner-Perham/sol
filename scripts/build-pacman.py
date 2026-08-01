#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys

def main():
    # 1. Read version from tauri.conf.json
    tauri_conf_path = 'src-tauri/tauri.conf.json'
    if not os.path.exists(tauri_conf_path):
        print(f"Error: {tauri_conf_path} not found. Run from the project root.", file=sys.stderr)
        sys.exit(1)
        
    with open(tauri_conf_path, 'r') as f:
        config = json.load(f)
    version = config.get('version', '0.1.0')
    
    # 2. Locate the .deb package
    deb_dir = 'src-tauri/target/release/bundle/deb'
    deb_filename = f"sol_{version}_amd64.deb"
    deb_path = os.path.join(deb_dir, deb_filename)
    
    if not os.path.exists(deb_path):
        print(f"Error: Debian package not found at {deb_path}.", file=sys.stderr)
        print("Please build the Tauri app first (e.g. using 'make build').", file=sys.stderr)
        sys.exit(1)
        
    # 3. Setup packaging directory
    pkg_dir = 'packaging'
    os.makedirs(pkg_dir, exist_ok=True)
    
    # Copy deb file to packaging dir
    shutil.copy(deb_path, os.path.join(pkg_dir, deb_filename))
    
    # 4. Generate PKGBUILD
    pkgbuild_content = f"""# Maintainer: Tanner Perham <tanner.perham@gmail.com>
pkgname=sol-bin
pkgver={version}
pkgrel=1
pkgdesc="A Tauri App"
arch=('x86_64')
url="https://github.com/Tanner-Perham/sol"
license=('MIT')
depends=('webkit2gtk-4.1' 'gtk3' 'libappindicator-gtk3' 'librsvg')
provides=('sol')
conflicts=('sol')
source=("{deb_filename}")
sha256sums=('SKIP')

package() {{
  cd "$srcdir"
  if [ -f data.tar.xz ]; then
    bsdtar -xf data.tar.xz -C "$pkgdir"
  elif [ -f data.tar.zst ]; then
    bsdtar -xf data.tar.zst -C "$pkgdir"
  elif [ -f data.tar.gz ]; then
    bsdtar -xf data.tar.gz -C "$pkgdir"
  else
    bsdtar -xf "{deb_filename}"
    bsdtar -xf data.tar.* -C "$pkgdir"
  fi
}}
"""
    pkgbuild_path = os.path.join(pkg_dir, 'PKGBUILD')
    with open(pkgbuild_path, 'w') as f:
        f.write(pkgbuild_content)
        
    print(f"Generated PKGBUILD for version {version} and copied Debian package.")
    
    # 5. Build the package
    # Check if makepkg is available on the system
    makepkg_bin = shutil.which('makepkg')
    if makepkg_bin:
        print("Building pacman package locally using makepkg...")
        try:
            subprocess.run(['makepkg', '-f'], cwd=pkg_dir, check=True)
            print("Pacman package built successfully!")
        except subprocess.CalledProcessError as e:
            print(f"Error: makepkg failed with exit code {e.returncode}", file=sys.stderr)
            sys.exit(e.returncode)
    else:
        # Check if we are running in GitHub Actions and can use Docker
        is_github_actions = os.environ.get('GITHUB_ACTIONS') == 'true'
        docker_bin = shutil.which('docker')
        if is_github_actions and docker_bin:
            print("makepkg not found, but Docker is available. Building inside Arch Linux container...")
            # We must get the absolute path of the current directory to mount it in Docker
            abs_cwd = os.getcwd()
            docker_cmd = [
                'docker', 'run', '--rm',
                '-v', f"{abs_cwd}:/workspace",
                '-w', '/workspace/packaging',
                'archlinux:latest',
                'bash', '-c',
                'HOST_OWNER=$(stat -c "%u:%g" /workspace) && '
                'pacman -Syu --noconfirm base-devel && '
                'useradd -m builder && '
                'chown -R builder:builder /workspace && '
                'runuser -u builder -- makepkg -f && '
                'chown -R $HOST_OWNER /workspace'
            ]
            try:
                subprocess.run(docker_cmd, check=True)
                print("Pacman package built successfully inside container!")
            except subprocess.CalledProcessError as e:
                print(f"Error: Docker build failed with exit code {e.returncode}", file=sys.stderr)
                sys.exit(e.returncode)
        else:
            print("Warning: makepkg is not installed on this system.", file=sys.stderr)
            print("To build the pacman package, run 'makepkg' inside the 'packaging/' directory on an Arch Linux system.", file=sys.stderr)
            print("Alternatively, install the package using 'makepkg' from the generated PKGBUILD.", file=sys.stderr)

if __name__ == '__main__':
    main()
