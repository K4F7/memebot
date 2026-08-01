# Separate administrator identity from management location

Across all plugins, explicit administrator QQ users and a fixed minimum Koishi authority of 4 determine who may manage data, while configured management groups determine where chat-based management actions may run. Group membership alone grants no administrative power, preventing a configured operations group from implicitly authorizing every member; private management actions still require an authorized user. The authority threshold is deliberately not configurable.
