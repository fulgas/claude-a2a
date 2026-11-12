# Changelog

## [0.8.0](https://github.com/fulgas/claude-a2a/compare/v0.7.0...v0.8.0) (2026-11-12)


### Features

* **server:** answer a task with files, from its outbox ([c1fb01c](https://github.com/fulgas/claude-a2a/commit/c1fb01c5f4166eb006f484e2db0a522f4d7d64d6))
* **server:** settings for the outbox limits ([6c24abb](https://github.com/fulgas/claude-a2a/commit/6c24abb74c31614f9c3364710f07c4d257d96b1b))

## [0.7.0](https://github.com/fulgas/claude-a2a/compare/v0.6.0...v0.7.0) (2026-11-04)


### Features

* **server:** show the caller a gateway relays for, from a Secure Passport ([15fec7e](https://github.com/fulgas/claude-a2a/commit/15fec7e2f91afede5ed15a1a5812eb53ffd34de8))


### Bug Fixes

* **server:** a failed task carries no answer ([45ffac4](https://github.com/fulgas/claude-a2a/commit/45ffac4433e56e08769fbf9336c9ac5f4494828e))

## [0.6.0](https://github.com/fulgas/claude-a2a/compare/v0.5.0...v0.6.0) (2026-11-02)


### Features

* **server:** name a machine caller by its client, and a delegated one by both ([39b3fd2](https://github.com/fulgas/claude-a2a/commit/39b3fd25c55658853103d705783799c99043dee6))

## [0.5.0](https://github.com/fulgas/claude-a2a/compare/v0.4.1...v0.5.0) (2026-11-02)


### Features

* **server:** a public host for the agent card ([f8983db](https://github.com/fulgas/claude-a2a/commit/f8983db26d2a973fdebf24a82d56bbd85601b0ee))

## [0.4.1](https://github.com/fulgas/claude-a2a/compare/v0.4.0...v0.4.1) (2026-11-02)


### Bug Fixes

* **plugin:** install over HTTPS, not SSH ([927c192](https://github.com/fulgas/claude-a2a/commit/927c192efd6d537fc062cbaf19c16ba736de49e2))

## [0.4.0](https://github.com/fulgas/claude-a2a/compare/v0.3.1...v0.4.0) (2026-11-02)


### Features

* **plugin:** install the latest release instead of main ([010bef6](https://github.com/fulgas/claude-a2a/commit/010bef69c31e80b2986149a9d78fad30683116b4))

## [0.3.1](https://github.com/fulgas/claude-a2a/compare/v0.3.0...v0.3.1) (2026-11-02)


### Bug Fixes

* **bridge:** name gRPC over TLS as https:// on the agent card ([5083ac9](https://github.com/fulgas/claude-a2a/commit/5083ac9428bcda3bd804a69282b63a9ab91174d6))
* **bridge:** name gRPC over TLS as https:// on the agent card ([426f13a](https://github.com/fulgas/claude-a2a/commit/426f13a00298ae7eb8ee21b234721a15fafbd5b6))
* **deps:** rebuild the bridge with the updated lock file ([2ad900d](https://github.com/fulgas/claude-a2a/commit/2ad900db81551c4a518c13b72734ac8f7e0dc742))

## [0.3.0](https://github.com/fulgas/claude-a2a/compare/v0.2.0...v0.3.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* **server:** incoming tasks now run in the conversation by default, where a caller can ask for what it holds. Set taskMode to subagent to keep the earlier behaviour, a fresh subagent per task.

### Features

* **plugin:** an icon for the plugin listing ([63983b0](https://github.com/fulgas/claude-a2a/commit/63983b0945484704a34e4f117a738695eb655be0))
* **server:** run tasks in the conversation, a fresh subagent or a fork ([e89f09d](https://github.com/fulgas/claude-a2a/commit/e89f09da5e8613e9cad4fa33897b078a8d2a7491))

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
