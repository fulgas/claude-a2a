# Changelog

## [0.2.0](https://github.com/fulgas/claude-a2a/compare/v0.1.0...v0.2.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* a client call no longer sends $A2A_TOKEN, the token tool parameter or the API key to an agent whose card does not ask for them. An agent that needs a credential must say so in its card's securitySchemes.

### Features

* every security scheme of the A2A specification, on both sides ([6717c2f](https://github.com/fulgas/claude-a2a/commit/6717c2f12344b24ca7bbd5c4a28549948aeeeac0))

## 0.1.0 (2026-10-28)


### Features

* **bridge:** A2A client and server over JSON-RPC with SSE, HTTP+JSON and gRPC ([4610c99](https://github.com/fulgas/claude-a2a/commit/4610c9967a45ae9d5fdfc0383a504ac82f6e750b))
* **bridge:** API key and OIDC JWT authentication, on both sides ([3fbaa0e](https://github.com/fulgas/claude-a2a/commit/3fbaa0e6f7791d623ffba02d5f95fdfb4ff018bb))
* **plugin:** A2A tools, /a2a-serve and saved server settings for Claude Code ([40bc332](https://github.com/fulgas/claude-a2a/commit/40bc3321099fe9464051bc4b16ae4ab0642af7e0))
* **plugin:** options for server and client credentials ([ba80169](https://github.com/fulgas/claude-a2a/commit/ba80169b8b0398a549465d81dd9d166dcbe1d0d3))
* **plugin:** options for the server's limits ([55728e3](https://github.com/fulgas/claude-a2a/commit/55728e350eac06ae28261e3217d0e0535646fde9))
* **server:** limit failed sign-ins and tasks ([45aace5](https://github.com/fulgas/claude-a2a/commit/45aace574f2033bc6eadabfd79f91a0397a87914))
