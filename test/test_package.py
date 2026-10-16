"""Keyless package contract; fixture files are synthetic, not real Windows builds."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class PackageTests(unittest.TestCase):
    def test_package_keeps_legacy_update_layout_without_private_key(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source, bundle, setup, sources, output = [root / n for n in ['source', 'bundle', 'setup', 'sources', 'output']]
            v = '0.1.0.dev12'
            app = bundle / 'versions' / v / 'BongoCatChatApp'
            files = {
                bundle / '.bongo-cat-chat-install': json.dumps({'schema': 2, 'active': v}),
                bundle / 'BongoCatChat.exe': 'fixture launcher',
                bundle / 'uninstall.ps1': 'fixture remover',
                app / 'BongoCatChatApp.exe': 'fixture app',
                app / '_internal/bongo_chat/legal/THIRD-PARTY-NOTICES.txt': 'fixture notices',
                setup / f'BongoCatChat-{v}-windows-x64-Setup.exe': 'fixture setup',
                source / 'docs/licensing/SOURCES.md': 'fixture source notices',
                sources / 'source.tar.gz': 'fixture source archive',
            }
            for path, value in files.items():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(value)
            lock = source / 'packaging/licenses/sources.lock.json'
            lock.parent.mkdir(parents=True)
            lock.write_text(json.dumps({'archives': [{'file': 'source.tar.gz', 'sha256': hashlib.sha256(b'fixture source archive').hexdigest()}]}))
            result = subprocess.run([sys.executable, '-I', str(ROOT / 'scripts/package.py'), '--source', str(source), '--bundle', str(bundle), '--setup', str(setup), '--sources', str(sources), '--output', str(output), '--version', v], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            manifest = json.loads((output / 'update-manifest.json').read_bytes())
            self.assertEqual(manifest['repository'], 'misosiruda/bongo-cat-chat')
            self.assertEqual(manifest['bootstrap_schema'], 1)
            self.assertEqual(manifest['data_schema'], 1)
            archive = output / manifest['archive']
            self.assertEqual(manifest['sha256'], hashlib.sha256(archive.read_bytes()).hexdigest())
            self.assertFalse((output / 'update-manifest.sig').exists())
            with zipfile.ZipFile(archive) as zipped:
                self.assertIn('BongoCatChat.exe', zipped.namelist())
                self.assertIn('BongoCatChatApp/BongoCatChatApp.exe', zipped.namelist())
                self.assertIn('uninstall.ps1', zipped.namelist())


if __name__ == '__main__':
    unittest.main()
