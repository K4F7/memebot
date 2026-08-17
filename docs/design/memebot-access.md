# memebot-access Design

Status: accepted and implemented on `main` (`f2aecc6`, final five-plugin acceptance).

Planning note: `memebot-faq` remains supported and is migrated to Access as part of this rollout, but it is excluded from subsequent feature development until explicitly reactivated.

## Scope

`memebot-access` is the central authorization source for every protected memebot plugin. Ordinary plugin features remain available in every QQ group. Business notification routing remains owned by each business plugin.

The first integration updates `memebot-activity`, `memebot-faq`, and `memebot-intake` together. Their local administrator and management-group configuration and predicates are removed rather than retained as fallbacks. Archive is a public-read QQ adapter and therefore does not load Access; Archive management does not live in this repository.

This rollout adds the Access management page. It does not create new Console pages for Activity, FAQ, or Intake, and it no longer exposes an Archive Console page; any future protected page must use the same authenticated-page and backend-listener boundary.

## Invariants

- One global administrator set applies to every protected plugin.
- Koishi authority 4 or higher always grants chat-side administrator identity.
- One global management-group set applies to every protected plugin.
- A management-group member is not thereby an administrator.
- Administrator-only reads require administrator identity but no management-group entry.
- Private chat state changes require administrator identity but no management-group entry.
- Group chat state changes require both administrator identity and an explicit management-group entry.
- An empty management-group set permits no group chat state changes.
- When Koishi Auth/Login is installed, any successfully authenticated Console account has complete access to all plugin management interfaces.
- When Koishi Auth/Login is installed, unauthenticated users receive neither navigable protected-plugin sidebar entries nor access to their backend Console listeners.
- When Koishi Auth/Login is absent, Console management interfaces are available without authentication.
- QQ user numbers and QQ group numbers are the only supported identity types.
- Notification groups are not authorization records and remain in their owning plugins.
- Access management surfaces list only explicit QQ administrators and do not enumerate or display Koishi authority 4 users.
- Successful Access changes affect subsequent authorization decisions immediately without restarting any plugin.
- Authorization is evaluated once when an operation begins; revocation does not cancel an operation already admitted.
- Ordinary service features remain available in both QQ groups and private chats.
- Stored QQ user and group numbers are trimmed decimal strings and unique within their respective sets.
- Trusted scheduled and internal system tasks do not require a user authorization session.

## Persistence and initialization

The Koishi database is the runtime source of truth. On first initialization, the plugin atomically imports configured administrator and management-group seeds and records an explicit initialization marker. Once marked, later starts never import seeds again, even when either set has deliberately been emptied.

Authorization changes keep no audit history. Only the current administrator and management-group sets are stored.

Existing business-plugin authorization settings require no migration because the current deployments contain no records. Access does not inspect or import configuration from other plugins.

## Chat management commands

- `access.admin.add <QQ>`
- `access.admin.rm <QQ>`
- `access.group.add <群号>`
- `access.group.rm <群号>`
- `access.list`

The `add` and `rm` commands are state changes and require full chat-side management authorization. `access.list` is an administrator-only read and therefore checks identity without restricting the current group.

`access.admin.rm` rejects an attempt to remove the chat actor's own QQ number. Console operations do not apply a self-removal rule because a Console account is not assumed to map reliably to one QQ identity. Removing the final other explicit administrator or the final management group is allowed.

## Consumer contract

Access exposes separate high-level service decisions for administrator identity and permission to perform a state-changing chat management action. The latter combines administrator identity, private-chat handling, management-group membership, and empty-set semantics. It also exposes a narrow explicit-administrator lookup for domain rules such as validating an Intake transfer target. Business plugins do not read access tables or recombine lower-level authorization predicates. A protected plugin does not start without the access service, and there is no local authorization fallback.

For state changes, the service centrally distinguishes identity denial (`你不是管理员。`) from location denial (`此群不是管理群，请私聊操作或先添加该群。`). Administrator-only reads can fail only the identity check. Business plugins do not define plugin-specific authorization-denial text.

## Acceptance criteria captured so far

- A configured administrator and a Koishi authority 4 user can manage every protected plugin.
- An ordinary user cannot perform a protected chat operation merely by being in a management group.
- An administrator can manage through private chat.
- An administrator is denied in an unlisted group, including when no management groups exist.
- Ordinary service commands remain available in unlisted groups.
- A notification group receives only notifications configured by its owning business plugin and gains no authorization.
- Initial configuration seeds an empty authorization store exactly once and never overwrites persisted changes.
- Seed import and the initialization marker succeed or fail as one initialization operation.
- Deliberately emptying either authorization set survives restart without reseeding.
- With Koishi Auth/Login installed, protected plugin navigation and backend operations are unavailable before login and fully usable after login without another authority-level gate.
- Without Koishi Auth/Login, protected Console navigation and backend operations remain available without authentication.
- Removing records uses the `rm` command segment rather than `remove`.
- Chat cannot remove the caller's own explicit administrator record; Console can remove any explicit administrator record.
- The final other explicit administrator and the final management group may be removed.
- Authorization changes do not create audit records.
- No automatic migration scans legacy authorization fields in business plugins.
- A protected plugin cannot start without the access service.
- No business plugin reads access persistence or reimplements identity-and-location rules.
- Chat denial identifies whether administrator identity or management location failed.
- Activity, FAQ, and Intake use the access service in the first rollout; Archive v2 is intentionally public-read only.
- None of those three protected plugins retains local administrator or management-group configuration.
- Activity, FAQ, and Intake receive no new Console pages in this rollout.
- Access lists contain only persisted explicit administrators and management groups.
- Adding or removing an administrator or management group changes the next authorization decision immediately.
- An admitted interactive or Console operation can finish after the actor is revoked; the actor's next operation is denied.
- Duplicate `add` and `rm` of an absent record are successful no-op outcomes reported as “已存在” and “不存在”.
- An Intake administrator may claim a record for themselves; transfer by QQ accepts only a persisted explicit administrator target.
- An implicit authority 4 administrator who is not explicitly listed can self-claim but cannot be selected as a transfer target.
- An administrator can view hidden FAQ entries in any group or private chat; management-group location does not restrict this read.
- An administrator can view all Intake records in any group or private chat; management-group location applies only when changing Intake state.
- Across all plugins, administrator-only reads are location-independent and only state-changing chat operations require a management location.
- Archive content management does not live in this repository; the Koishi Archive plugin performs only public QQ read commands and fail-closes until a later content-backend adapter is bound.

Architectural rationale is recorded in [ADR 0010](../adr/0010-centralize-plugin-authorization.md).
