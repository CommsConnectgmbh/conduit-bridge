# Sonos device CA key

The optional Alexa speaker (`ALEXA_SPEAKER`, see `docs/ENTERPRISE.md`) plays an answer only on a speaker whose certificate is signed by the Sonos device CA and issued to the configured player. Sonos does not publish that CA, and the players send only their own certificate, so `src/sonos.mjs` pins the CA's public key, recovered from player certificates with `recover.py`.

The pinned key was recovered from five players (Play:1, One, Era 100 SL, Move) with different certificate dates, and verifies all five. To check it with your own speakers:

```bash
for ip in <speaker addresses>; do
  echo | openssl s_client -connect "$ip:1443" 2>/dev/null | openssl x509 -outform PEM > "leaf-$ip.pem"
done
pip install gmpy2 cryptography
python recover.py leaf-*.pem
```

The SubjectPublicKeyInfo SHA-256 of the pinned key is `f3c972f64d45808e0931da21cf9f9562825b13a0784f0955963533820a54b6c6`.

Only public material goes in: the certificates are what every speaker shows anyone on the network. The certificates themselves are not stored here because they name the players' MAC addresses.
