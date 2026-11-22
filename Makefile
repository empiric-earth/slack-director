PREFIX ?= $(HOME)/.config/opencode
PLUGIN_DIR := $(PREFIX)/plugins/slack-director
AGENT_DIR := $(PREFIX)/agents
DIRECTOR_AGENT := $(AGENT_DIR)/slack-director.md
REFRESH_AGENT := $(AGENT_DIR)/slack-director-refresh.md
# The read-only triage agent is gone from the package. The install target only
# copies, so it removes a copy an earlier install left behind, by its exact name.
RETIRED_TRIAGE_AGENT := $(AGENT_DIR)/slack-director-triage.md
# A skill folder in the config directory wins over a plugin's skill of the same
# id, silently, so a copy left there shadows the one this plugin serves.
STALE_SKILL_DIR := $(PREFIX)/skills/slack-director

.PHONY: test install uninstall

test:
	node --test --test-reporter=tap test/*.test.js

install:
	mkdir -p "$(PLUGIN_DIR)" "$(AGENT_DIR)"
	cp index.js tui.js rpc.js package.json "$(PLUGIN_DIR)/"
	rm -rf "$(PLUGIN_DIR)/src" "$(PLUGIN_DIR)/skills"
	cp -R src "$(PLUGIN_DIR)/src"
	cp -R skills "$(PLUGIN_DIR)/skills"
	cp agents/slack-director.md "$(DIRECTOR_AGENT)"
	cp agents/slack-director-refresh.md "$(REFRESH_AGENT)"
	rm -f "$(RETIRED_TRIAGE_AGENT)"
	rm -rf "$(STALE_SKILL_DIR)"
	@echo "Installed. Run 'opencode reload' to load the slack-director agents, the skill and the flag watcher."

uninstall:
	rm -rf "$(PLUGIN_DIR)"
	rm -f "$(DIRECTOR_AGENT)" "$(REFRESH_AGENT)" "$(RETIRED_TRIAGE_AGENT)"
	@echo "Uninstalled. Removed only the slack-director plugin directory and the slack-director agent files."
