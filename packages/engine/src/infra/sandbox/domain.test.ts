import { describe, expect, test } from "vitest"
import { Domain } from "./domain"

describe("Domain.matches", () => {
  test("ignores case and a trailing dot", () => {
    expect(Domain.matches("GitHub.com", "github.com.", 443)).toBe(true)
    expect(Domain.matches("github.com.", "GITHUB.COM", 443)).toBe(true)
  })

  test("*.example.com covers subdomains but not example.com itself", () => {
    expect(Domain.matches("*.example.com", "a.example.com", 443)).toBe(true)
    expect(Domain.matches("*.example.com", "a.b.example.com", 443)).toBe(true)
    expect(Domain.matches("*.example.com", "example.com", 443)).toBe(false)
    expect(Domain.matches("*.example.com", "badexample.com", 443)).toBe(false)
  })

  test("* covers every name", () => {
    expect(Domain.matches("*", "anything.test", 80)).toBe(true)
  })

  test("a port in the pattern must match; no port means any port", () => {
    expect(Domain.matches("host.test:8443", "host.test", 8443)).toBe(true)
    expect(Domain.matches("host.test:8443", "host.test", 443)).toBe(false)
    expect(Domain.matches("host.test", "host.test", 8443)).toBe(true)
  })

  test("IP addresses match only when written out; * covers them only when denying", () => {
    expect(Domain.matches("10.0.0.5", "10.0.0.5", 80)).toBe(true)
    expect(Domain.matches("*", "10.0.0.5", 80)).toBe(false)
    expect(Domain.matches("*", "10.0.0.5", 80, "deny")).toBe(true)
    expect(Domain.matches("*.0.0.5", "10.0.0.5", 80)).toBe(false)
  })

  test("IPv6 is written in brackets, with or without a port", () => {
    expect(Domain.matches("[::1]", "::1", 80)).toBe(true)
    expect(Domain.matches("[::1]", "[::1]", 80)).toBe(true)
    expect(Domain.matches("[::1]:8080", "::1", 8080)).toBe(true)
    expect(Domain.matches("[::1]:8080", "::1", 80)).toBe(false)
  })
})

describe("Domain.valid", () => {
  test("accepts names, wildcards, ports and IP literals; rejects globs in the middle", () => {
    for (const pattern of ["*", "example.com", "*.example.com", "host.test:8443", "10.0.0.5", "[::1]", "[::1]:80"])
      expect(Domain.valid(pattern), pattern).toBe(true)
    for (const pattern of ["exa*mple.org", "", "a b.com", "http://x.com", "*.", "example.com:99999"])
      expect(Domain.valid(pattern), pattern).toBe(false)
  })
})

describe("Domain.loopback", () => {
  test("knows localhost and the loopback ranges", () => {
    for (const host of ["localhost", "LOCALHOST.", "127.0.0.1", "127.5.6.7", "::1", "[::1]", "::ffff:127.0.0.1"])
      expect(Domain.loopback(host), host).toBe(true)
    for (const host of ["example.com", "10.0.0.1", "::2", "128.0.0.1"]) expect(Domain.loopback(host), host).toBe(false)
  })
})
