"""One-time migration: DPAPI -> pinned public key check -> GitHub secret via stdin.

Run with a trusted Python installation and -I. Never imports application code,
prints key material, writes a plaintext key, rotates a key or deletes the input.
"""
import argparse
import base64
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

REPOSITORY = 'misosiruda/bongo-cat-chat-release'
PUBLIC_KEY = 'Wu15J5pBex0qY1+yjzg6dr1CYAXfbakomfHzkNNC9b0='


def github(*args):
    result = subprocess.run(['gh', *args], capture_output=True, check=True)
    return json.loads(result.stdout)


def decrypt(path):
    if os.name != 'nt':
        raise RuntimeError('Windows user-scoped DPAPI required')
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    protected = path.read_bytes()
    buffer = (ctypes.c_ubyte * len(protected)).from_buffer_copy(protected)
    incoming, outgoing = Blob(len(protected), buffer), Blob()
    function = ctypes.WinDLL('crypt32', use_last_error=True).CryptUnprotectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
        raise RuntimeError('DPAPI decryption failed; do not generate a replacement key')
    free = ctypes.WinDLL('kernel32').LocalFree
    free.argtypes, free.restype = [ctypes.c_void_p], ctypes.c_void_p
    try:
        return bytearray(ctypes.string_at(outgoing.data, outgoing.size))
    finally:
        ctypes.memset(outgoing.data, 0, outgoing.size)
        free(outgoing.data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dpapi', required=True, type=Path)
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    if github('api', 'user')['login'] != 'misosiruda':
        raise RuntimeError('Unexpected GitHub account')
    environment = github('api', f'repos/{REPOSITORY}/environments/release-signing')
    reviewers = [r for rule in environment['protection_rules'] if rule['type'] == 'required_reviewers' for r in rule['reviewers']]
    if not any(r['reviewer'].get('login') == 'misosiruda' for r in reviewers) or environment.get('can_admins_bypass', True):
        raise RuntimeError('Required owner approval and no-admin-bypass must be configured first')
    policies = github('api', f'repos/{REPOSITORY}/environments/release-signing/deployment-branch-policies')['branch_policies']
    if len(policies) != 1 or policies[0]['name'] != 'main' or policies[0]['type'] != 'branch':
        raise RuntimeError('Only release repository main may access the key')
    raw = decrypt(args.dpapi.resolve(strict=True))
    try:
        key = Ed25519PrivateKey.from_private_bytes(bytes(raw))
        if base64.b64encode(key.public_key().public_bytes_raw()).decode() != PUBLIC_KEY:
            raise RuntimeError('Pinned public key mismatch')
        fixtures = Path(__file__).resolve().parents[1] / 'fixtures'
        expected = base64.b64decode((fixtures / 'dev11-signature.txt').read_text().strip(), validate=True)
        if key.sign((fixtures / 'dev11-manifest.json').read_bytes()) != expected:
            raise RuntimeError('Published dev11 signature mismatch')
        if not args.check_only:
            result = subprocess.run(['gh', 'secret', 'set', 'UPDATE_SIGNING_KEY', '--repo', REPOSITORY, '--env', 'release-signing'], input=base64.b64encode(raw), capture_output=True)
            if result.returncode:
                raise RuntimeError('Secret upload failed; key details suppressed')
        print('Pinned key and existing public signature verified. ' + ('No secret changed.' if args.check_only else 'Protected environment secret set.'))
        print('Original DPAPI file retained until cloud proof and independent recovery backup are verified.')
    finally:
        raw[:] = b'\0' * len(raw)


if __name__ == '__main__':
    main()
