"""Recover the RSA public key of the Sonos device CA from player certificates.

Each Sonos player presents its own certificate on port 1443, signed with
sha256WithRSAEncryption (PKCS#1 v1.5) by the "Sonos Device Authentication Root
CA", which Sonos does not publish. For every such certificate the CA modulus n
divides s^e - EM(tbsCertificate), so the gcd over a few certificates is n.
The result is then checked: it must verify every certificate given.

    pip install gmpy2 cryptography
    python recover.py leaf-1.pem leaf-2.pem leaf-3.pem ...

Prints the key as PEM and the SHA-256 of its SubjectPublicKeyInfo; compare it
with SONOS_DEVICE_CA_PUBKEY in src/sonos.mjs.
"""
import hashlib
import sys

import gmpy2
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

E = 65537
DIGEST_INFO_SHA256 = bytes.fromhex("3031300d060960864801650304020105000420")


def encoded_message(cert, k):
    h = hashlib.sha256(cert.tbs_certificate_bytes).digest()
    return b"\x00\x01" + b"\xff" * (k - 3 - len(DIGEST_INFO_SHA256) - len(h)) + b"\x00" + DIGEST_INFO_SHA256 + h


def main(paths):
    certs = [x509.load_pem_x509_certificate(open(p, "rb").read()) for p in paths]
    if len(certs) < 2:
        sys.exit("need at least two certificates from different players")
    g = None
    for c in certs:
        s = c.signature
        x = gmpy2.mpz(int.from_bytes(s, "big")) ** E - int.from_bytes(encoded_message(c, len(s)), "big")
        g = x if g is None else gmpy2.gcd(g, x)
    bits = 8 * len(certs[0].signature)
    for p in range(2, 100_000):
        while g % p == 0 and g.bit_length() > bits:
            g //= p
    key = rsa.RSAPublicNumbers(E, int(g)).public_key()
    for c in certs:
        key.verify(c.signature, c.tbs_certificate_bytes, padding.PKCS1v15(), hashes.SHA256())
    der = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    print(key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode(), end="")
    print(f"modulus {key.key_size} bits, verifies all {len(certs)} certificates")
    print("SubjectPublicKeyInfo sha256", hashlib.sha256(der).hexdigest())


if __name__ == "__main__":
    main(sys.argv[1:])
