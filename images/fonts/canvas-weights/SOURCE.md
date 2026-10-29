# WA-FIX2B (R3) canvas font weights — provenance

Source: Google Fonts `ofl/roboto/Roboto[wdth,wght].ttf` (variable, Apache-2.0),
downloaded 2026-10-29 from `raw.githubusercontent.com/google/fonts/main`.

Instantiation: `fontTools 4.62.1` `varLib.instancer`, axes pinned
`wght=<weight>,wdth=100`, `updateFontNames=True`, deterministic output.

sha256 of the downloaded variable font:
`d7598e12c5dbef095ff8272cfc55da0250bd07fbdecbac8a530b9b277872a134`  (488584 bytes)

Instantiated files (sha256, size):

| file | weight | sha256 | bytes |
|---|---|---|---|
| Roboto-Thin.ttf   | 100 | a79ac8066e198ac4fe19d07837e9a48a176135107e35db09e5153a5df8af7ad5 | 157284 |
| Roboto-Light.ttf  | 300 | a3218b4da689d12c96c81bbe7933fbc15210e555d4a42f6f57b7cdb70bd2b318 | 157672 |
| Roboto-Medium.ttf | 500 | 94975ed8c75f007ab69d15b76b088c00851ad3217fe8e3232da1d6eec6ccdb4f | 157732 |
| Roboto-Black.ttf  | 900 | 90e347227c9401b66e646e29c2a237f612deacbf12d701dfd942525496aaaaa6 | 158708 |

The image's own `Roboto-Regular.ttf` (weight 400, /system/fonts) is the
fifth variant and needs NO mount (bucket 'regular').

Reproduce (host, isolated): python3 + fontTools ≥4.62, instantiate as above;
byte-identical results pin this directory (asset test asserts presence and
size, not hashes — patching weights would break canvas determinism records).
