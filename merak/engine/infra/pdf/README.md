# PDF extraction

`Extract` is the only package boundary that imports `github.com/ledongthuc/pdf`. The compatible adapter and `read_file` share this package. It returns text or a typed failure; it never emits logs or user-facing messages. The adapter drops failed documents, records `document` in `dropped`, and continues the request. `read_file` returns extracted text when available and otherwise preserves the native document for the adapter.

Default limits are 16 MiB input, 16 MiB cumulative decoded content/font streams, 500 pages and 4 MiB cumulative text. Extraction checks decoded streams through a limited reader before asking the library to extract each page. It stops at the first failed limit and never calls the library's whole-document `GetPlainText`. Text is checked after each page, before retaining that page or reading subsequent pages. This is not a process memory quota: the library still allocates a page's parsed objects and text.

The library has no general decompression quota. Local extraction therefore accepts classic cross-reference tables and unfiltered, single-Flate or single-ASCII85 content/font streams. It rejects encrypted files, compressed indexes, incremental cross-reference chains, chained filters and predictors before those paths can decode without a bound. Native PDF endpoints still receive original documents. The adapter reports unsupported extraction as a dropped document; it never pretends that missing text was extracted. Page/resource traversal and cross-reference entry counts are bounded separately.

## Pinned dependency review

Reviewed on 2026-11-08 before adding the module. The upstream default branch is `master`. Its head was [`5e46805f718e722f9c806c4a944e932e6aaaa9f1`](https://github.com/ledongthuc/pdf/commit/5e46805f718e722f9c806c4a944e932e6aaaa9f1), dated 2026-10-20 12:58:53 UTC. This exactly matches `v0.0.0-20261020125853-5e46805f718e`.

The reviewed first-parent changes were:

- `5e46805f718e`: terminate incomplete hexadecimal strings at EOF; regression tests cover truncated content streams.
- [`ea3800890f56`](https://github.com/ledongthuc/pdf/commit/ea3800890f56d154fe994877057029d5032b161c): correct RC4 object-key lengths and add an encrypted fixture test.
- [`7e2a21538c29`](https://github.com/ledongthuc/pdf/commit/7e2a21538c29af45ff19371d115267a7aecab486): carry CMap range offsets across bytes, with Unicode regression coverage.
- [`6c8c28e0e8a`](https://github.com/ledongthuc/pdf/commit/6c8c28e0e8a07a3452f9d8cf3090ed6e856d8f24): support UniGB-UCS2-H decoding, with Chinese text coverage.

The [pinned go.mod](https://github.com/ledongthuc/pdf/blob/5e46805f718e722f9c806c4a944e932e6aaaa9f1/go.mod) declares Go 1.24.1 and no third-party modules. The [pinned license](https://github.com/ledongthuc/pdf/blob/5e46805f718e722f9c806c4a944e932e6aaaa9f1/LICENSE) is BSD-3-Clause. Its full notice is included in the repository's third-party notices.
