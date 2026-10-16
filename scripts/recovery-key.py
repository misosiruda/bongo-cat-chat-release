"""Portable encrypted backup. Passwords are entered locally, never as arguments.

No upload, raw key file, key replacement or deletion is performed.
Run using a trusted Python environment with -I.
"""
import argparse
import base64
import getpass
import hashlib
import importlib.util
import json
from pathlib import Path
import secrets
import sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

PUBLIC_KEY = 'Wu15J5pBex0qY1+yjzg6dr1CYAXfbakomfHzkNNC9b0='
AAD = b'BONGO_CAT_CHAT_RECOVERY_V1'


def derive(password, salt):
    return Scrypt(salt=salt, length=32, n=131072, r=8, p=1).derive(password.encode('utf-8'))


def seal(raw, password):
    if len(password) < 16:
        raise ValueError('Use at least 16 characters in a unique recovery passphrase')
    salt, nonce = secrets.token_bytes(16), secrets.token_bytes(12)
    ciphertext = AESGCM(derive(password, salt)).encrypt(nonce, raw, AAD)
    return json.dumps({'schema': 1, 'kdf': 'scrypt-n131072-r8-p1', 'cipher': 'AES-256-GCM',
                       'salt': base64.b64encode(salt).decode(), 'nonce': base64.b64encode(nonce).decode(),
                       'ciphertext': base64.b64encode(ciphertext).decode()}, sort_keys=True).encode()


def recover(payload, password, expected_public_key=PUBLIC_KEY):
    if len(payload) > 4096:
        raise ValueError('Backup too large')
    value = json.loads(payload)
    if set(value) != {'schema', 'kdf', 'cipher', 'salt', 'nonce', 'ciphertext'} or value['schema'] != 1 or value['kdf'] != 'scrypt-n131072-r8-p1' or value['cipher'] != 'AES-256-GCM':
        raise ValueError('Unsupported backup format')
    salt, nonce, ciphertext = [base64.b64decode(value[k], validate=True) for k in ('salt', 'nonce', 'ciphertext')]
    if len(salt) != 16 or len(nonce) != 12 or len(ciphertext) != 48:
        raise ValueError('Invalid backup lengths')
    raw = AESGCM(derive(password, salt)).decrypt(nonce, ciphertext, AAD)
    key = Ed25519PrivateKey.from_private_bytes(raw)
    if base64.b64encode(key.public_key().public_bytes_raw()).decode() != expected_public_key:
        raise ValueError('Restored key does not match the existing client public key')
    return raw


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['export', 'verify'])
    parser.add_argument('--dpapi', type=Path)
    parser.add_argument('--backup', type=Path, required=True)
    args = parser.parse_args()
    if not sys.stdin.isatty():
        raise RuntimeError('Interactive local terminal required; do not send the passphrase through chat or a pipe')
    if args.mode == 'export':
        if not args.dpapi:
            raise ValueError('--dpapi is required for export')
        if args.backup.exists():
            raise ValueError('Backup already exists; never overwrite')
        password = getpass.getpass('New recovery passphrase (at least 16 characters): ')
        if password != getpass.getpass('Repeat recovery passphrase: '):
            raise ValueError('Passphrases do not match')
        spec = importlib.util.spec_from_file_location('trusted_dpapi_import', Path(__file__).with_name('import-key.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        raw = module.decrypt(args.dpapi.resolve(strict=True))
        try:
            key = Ed25519PrivateKey.from_private_bytes(bytes(raw))
            if base64.b64encode(key.public_key().public_bytes_raw()).decode() != PUBLIC_KEY:
                raise ValueError('Pinned public key mismatch')
            payload = seal(bytes(raw), password)
            if recover(payload, password) != bytes(raw):
                raise RuntimeError('Backup roundtrip failed')
            with args.backup.open('xb') as stream:
                stream.write(payload)
        finally:
            raw[:] = b'\0' * len(raw)
        print('Encrypted backup created. Original DPAPI key retained.')
        print('Run verify in a NEW process, then store the backup offline and the passphrase separately.')
    else:
        if args.backup.stat().st_size > 4096:
            raise ValueError('Backup too large')
        payload = args.backup.read_bytes()
        password = getpass.getpass('Recovery passphrase: ')
        recover(payload, password)
        print('Recovered key matches the existing client public key. No key written or replaced.')
    print('Encrypted backup SHA-256: ' + hashlib.sha256(payload).hexdigest())


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Recovery operation failed. Check the path, format, password and pinned key; original keys are unchanged.') from None
