package engine_test

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// frozen lists every non-test file of the root package at the time it was closed to new code. New engine code belongs
// in a package of its own under engine/; when a slice moves or deletes a file, it removes the file from this list too.
var frozen = []string{
	"blob.go",
	"cloud.go",
	"cloud_events.go",
	"cloud_forward.go",
	"cloud_projection.go",
	"configuration.go",
	"conversation.go",
	"default_model.go",
	"device_host.go",
	"device_question.go",
	"device_recovery.go",
	"device_source.go",
	"device_tool.go",
	"device_worker.go",
	"documents.go",
	"engine.go",
	"errors.go",
	"execution_budget.go",
	"external.go",
	"fastlane.go",
	"files.go",
	"group.go",
	"group_approval_timeout.go",
	"group_handover.go",
	"group_lookup.go",
	"group_mcp.go",
	"group_notice.go",
	"group_pause.go",
	"group_permission.go",
	"group_phase.go",
	"group_publish.go",
	"group_question.go",
	"group_question_route.go",
	"group_queue.go",
	"group_recovery.go",
	"group_review.go",
	"group_say.go",
	"group_settings.go",
	"group_tools.go",
	"group_trigger.go",
	"group_watch.go",
	"group_workspace.go",
	"history.go",
	"leader_failure.go",
	"leader_runner.go",
	"member_execution.go",
	"member_probe.go",
	"memory.go",
	"merge.go",
	"network_policy.go",
	"profiles.go",
	"recovery.go",
	"remote.go",
	"remote_delivery.go",
	"remote_lookup.go",
	"remote_peer.go",
	"remote_workspace.go",
	"sandbox.go",
	"sentinel.go",
	"shutdown.go",
	"task_budget.go",
	"task_packet.go",
	"worker.go",
	"worker_budget.go",
	"workspace_mcp.go",
	"workspace_setup.go",
}

func TestTheRootPackageGetsNoNewFiles(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	var files []string
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && strings.HasSuffix(name, ".go") && !strings.HasSuffix(name, "_test.go") {
			files = append(files, filepath.ToSlash(name))
		}
	}
	for _, name := range files {
		if !slices.Contains(frozen, name) {
			t.Errorf("%s is new: put new code in a package under engine/", name)
		}
	}
	for _, name := range frozen {
		if !slices.Contains(files, name) {
			t.Errorf("%s was removed: delete it from the frozen list", name)
		}
	}
}
