"""Synthetic portable backup tests; never opens an operational DPAPI key."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import unittest
import tempfile
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).resolve().parents[1] / 'scripts/recovery-key.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoveryTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows DPAPI roundtrip only')
    def test_restored_seed_uses_current_user_dpapi(self):
        import_spec = importlib.util.spec_from_file_location('import_key', Path(__file__).resolve().parents[1] / 'scripts/import-key.py')
        helper = importlib.util.module_from_spec(import_spec)
        import_spec.loader.exec_module(helper)
        raw = Ed25519PrivateKey.generate().private_bytes_raw()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'synthetic.dpapi'
            path.write_bytes(recovery.protect_for_current_user(raw))
            self.assertEqual(bytes(helper.decrypt(path)), raw)

    def test_portable_encryption_wrong_password_tampering_and_wrong_key(self):
        raw = Ed25519PrivateKey.generate().private_bytes_raw()
        public = base64.b64encode(Ed25519PrivateKey.from_private_bytes(raw).public_key().public_bytes_raw()).decode()
        password = 'synthetic fixture passphrase 1234'
        sealed = recovery.seal(raw, password)
        self.assertNotIn(base64.b64encode(raw), sealed)
        self.assertEqual(recovery.recover(sealed, password, public), raw)
        with self.assertRaises(Exception):
            recovery.recover(sealed, 'wrong password', public)
        with self.assertRaises(ValueError):
            recovery.recover(sealed, password)
        changed = json.loads(sealed)
        changed['ciphertext'] = base64.b64encode(b'X' * 48).decode()
        with self.assertRaises(Exception):
            recovery.recover(json.dumps(changed).encode(), password, public)

    def test_rejects_weak_password_and_unbounded_or_changed_parameters(self):
        with self.assertRaises(ValueError):
            recovery.seal(b'X' * 32, 'short')
        with self.assertRaises(ValueError):
            recovery.recover(b'X' * 5000, 'password')
        with self.assertRaises(ValueError):
            recovery.recover(b'{"schema":2}', 'password')


if __name__ == '__main__':
    unittest.main()
