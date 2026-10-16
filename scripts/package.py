"""Create unsigned payloads using only Python's standard library; no key access."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import zipfile


def main():
    parser = argparse.ArgumentParser()
    for name in ('source', 'bundle', 'setup', 'sources', 'output', 'version'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    version = args.version
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:\.dev\d+)?', version):
        raise ValueError('Invalid version')
    source, bundle, output = Path(args.source), Path(args.bundle), Path(args.output)
    marker = json.loads((bundle / '.bongo-cat-chat-install').read_text(encoding='utf-8-sig'))
    if marker['active'] != version:
        raise ValueError('Bundle version mismatch')
    output.mkdir(parents=True, exist_ok=False)
    archive = output / 'bongo-cat-chat-windows-x64.zip'
    app = bundle / 'versions' / version / 'BongoCatChatApp'
    with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED) as zipped:
        zipped.write(bundle / 'BongoCatChat.exe', 'BongoCatChat.exe')
        zipped.write(bundle / 'uninstall.ps1', 'uninstall.ps1')
        for path in sorted(app.rglob('*')):
            if path.is_symlink():
                raise ValueError('Symlink in bundle')
            if path.is_file():
                zipped.write(path, 'BongoCatChatApp/' + path.relative_to(app).as_posix())
    with archive.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    manifest = {'schema': 1, 'repository': 'misosiruda/bongo-cat-chat', 'version': version,
                'platform': 'windows-x64', 'archive': archive.name, 'size': archive.stat().st_size,
                'sha256': digest, 'data_schema': 1, 'bootstrap_schema': 1}
    (output / 'update-manifest.json').write_bytes(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode())
    shutil.copyfile(Path(args.setup) / f'BongoCatChat-{version}-windows-x64-Setup.exe', output / f'BongoCatChat-{version}-windows-x64-Setup.exe')
    shutil.copyfile(source / 'packaging/licenses/sources.lock.json', output / 'sources.lock.json')
    shutil.copyfile(source / 'docs/licensing/SOURCES.md', output / 'SOURCES.md')
    shutil.copyfile(app / '_internal/bongo_chat/legal/THIRD-PARTY-NOTICES.txt', output / 'THIRD-PARTY-NOTICES.txt')
    lock = json.loads((output / 'sources.lock.json').read_text())
    with zipfile.ZipFile(output / f'BongoCatChat-{version}-corresponding-sources.zip', 'x', zipfile.ZIP_STORED) as zipped:
        for item in lock['archives']:
            name = item['file']
            if Path(name).name != name:
                raise ValueError('Invalid source archive name')
            path = Path(args.sources) / name
            with path.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != item['sha256']:
                    raise ValueError('Source archive changed')
            zipped.write(path, name)
        zipped.write(output / 'sources.lock.json', 'sources.lock.json')
        zipped.write(output / 'SOURCES.md', 'SOURCES.md')


if __name__ == '__main__':
    main()
