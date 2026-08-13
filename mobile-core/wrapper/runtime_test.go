package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/metacubex/mihomo/config"
	"github.com/metacubex/mihomo/hub/executor"
)

const fixtureConfig = `
mode: rule
log-level: warning
proxies: []
proxy-groups: []
rules:
  - MATCH,DIRECT
`

const routeConfig = `
mode: rule
log-level: warning
proxies: []
proxy-groups:
  - name: Proxy
    type: select
    proxies: [DIRECT, REJECT]
rules:
  - MATCH,DIRECT
`

func decodeEnvelope(t *testing.T, result coreResult) responseEnvelope {
	t.Helper()
	var envelope responseEnvelope
	if err := json.Unmarshal(result.payload, &envelope); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return envelope
}

func TestDecodeStrictRejectsUnknownAndTrailingValues(t *testing.T) {
	var request initializeRequest
	if err := decodeStrict([]byte(`{"abiVersion":1,"path":"/tmp/core"}`), &request); err == nil {
		t.Fatal("expected unknown path field to be rejected")
	}
	if err := decodeStrict([]byte(`{"abiVersion":1} {}`), &request); err == nil {
		t.Fatal("expected trailing JSON value to be rejected")
	}
}

func TestRawConfigRejectsPlatformAndRemoteAuthority(t *testing.T) {
	tests := []string{
		"external-controller: 127.0.0.1:9090\n",
		"tun:\n  enable: true\n",
		"proxy-providers:\n  remote:\n    type: http\n    url: https://example.com/profile.yaml\n",
		"listeners:\n  - name: local\n    type: mixed\n    port: 7890\n",
		"ntp:\n  write-to-system: true\n",
	}
	for _, input := range tests {
		raw, err := config.UnmarshalRawConfig([]byte(input + "proxies: []\nrules: []\n"))
		if err != nil {
			t.Fatalf("parse boundary fixture: %v", err)
		}
		if err := validateRawConfig(raw); err == nil {
			t.Fatalf("expected forbidden configuration to fail: %s", input)
		}
	}
}

func TestCoreLoadsBytesAndPublishesBoundedEvents(t *testing.T) {
	core := &coreRuntime{phase: phaseInactive}
	initialized := core.initialize([]byte(`{"abiVersion":1}`), func(int) error { return nil })
	if initialized.status != statusOK {
		t.Fatalf("initialize: %s", initialized.payload)
	}
	if _, _, _, err := parseConfig([]byte(fixtureConfig)); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	loaded := core.loadConfig([]byte(fixtureConfig))
	if loaded.status != statusOK {
		t.Fatalf("load: %s", loaded.payload)
	}
	if core.configDigest == "" || core.loaded == nil {
		t.Fatal("load did not retain parsed configuration and digest")
	}

	snapshot := core.snapshot([]byte(`{"kind":"status","limit":1}`))
	if snapshot.status != statusOK || !strings.Contains(string(snapshot.payload), `"loaded":true`) {
		t.Fatalf("status snapshot: %s", snapshot.payload)
	}
	routes := core.snapshot([]byte(`{"kind":"routes","limit":512}`))
	if routes.status != statusOK ||
		!strings.Contains(string(routes.payload), `"groups":[]`) ||
		strings.Contains(string(routes.payload), `"name":"GLOBAL"`) {
		t.Fatalf("inactive committed routes snapshot: %s", routes.payload)
	}
	command := core.command([]byte(`{"operation":"close-all-connections"}`))
	if command.status != statusConflict {
		t.Fatalf("inactive command status = %d", command.status)
	}
	events := core.pollEvents([]byte(`{"afterSequence":"0","limit":1}`))
	if events.status != statusOK {
		t.Fatalf("poll events: %s", events.payload)
	}
	if !strings.Contains(string(events.payload), `"configuration-loaded"`) {
		t.Fatalf("missing configuration event: %s", events.payload)
	}
	decodeEnvelope(t, events)

	previousLoaded := core.loaded
	previousDigest := core.configDigest
	rejected := core.loadConfig([]byte("external-controller: 127.0.0.1:9090\nproxies: []\nrules: []\n"))
	if rejected.status != statusConfigRejected {
		t.Fatalf("replacement rejection status = %d", rejected.status)
	}
	if core.loaded != previousLoaded || core.configDigest != previousDigest {
		t.Fatal("failed replacement did not preserve the prior loaded configuration")
	}
}

func TestInactiveCommittedRoutesSnapshotDoesNotRequireStartApplyConfig(t *testing.T) {
	const pollutedConfig = `
mode: global
proxies: []
proxy-groups:
  - name: Old
    type: select
    proxies: [REJECT, DIRECT]
rules:
  - MATCH,REJECT
`
	polluted, _, _, err := parseConfig([]byte(pollutedConfig))
	if err != nil {
		t.Fatalf("parse polluted global tunnel fixture: %v", err)
	}
	executor.ApplyConfig(polluted, true)
	t.Cleanup(executor.Shutdown)

	core := &coreRuntime{phase: phaseInactive}
	if result := core.initialize([]byte(`{"abiVersion":1}`), func(int) error { return nil }); result.status != statusOK {
		t.Fatalf("initialize: %s", result.payload)
	}
	if result := core.loadConfig([]byte(routeConfig)); result.status != statusOK {
		t.Fatalf("load: %s", result.payload)
	}

	snapshot := core.snapshot([]byte(`{"kind":"routes","limit":512}`))
	if snapshot.status != statusOK ||
		!strings.Contains(string(snapshot.payload), `"name":"Proxy"`) ||
		!strings.Contains(string(snapshot.payload), `"selected":"DIRECT"`) ||
		strings.Contains(string(snapshot.payload), `"name":"Old"`) ||
		!strings.Contains(string(snapshot.payload), `"mode":"rule"`) {
		t.Fatalf("inactive committed routes snapshot: %s", snapshot.payload)
	}
	if core.phase != phaseInactive {
		t.Fatalf("route observation started Core: %s", core.phase)
	}
}

func TestRoutesSnapshotTruncatesOnlyOmittedPolicyGroups(t *testing.T) {
	configWithGroups := func(groupCount int) []byte {
		var raw strings.Builder
		raw.WriteString("mode: rule\nproxies:\n  - name: Ordinary\n    type: socks5\n    server: 127.0.0.1\n    port: 1080\nproxy-groups:\n")
		for index := range groupCount {
			fmt.Fprintf(&raw, "  - name: Group-%03d\n    type: select\n    proxies: [DIRECT, REJECT]\n", index)
		}
		raw.WriteString("rules:\n  - MATCH,DIRECT\n")
		return []byte(raw.String())
	}

	parsed, _, configured, err := parseConfig(configWithGroups(512))
	if err != nil {
		t.Fatalf("parse boundary fixture: %v", err)
	}
	completeSnapshot := routesSnapshot(512, parsed.Proxies, parsed.General.Mode.String(), configured)
	if completeSnapshot["truncated"] != false {
		t.Fatal("built-ins made a complete configured policy-group snapshot appear truncated")
	}
	if groups := completeSnapshot["groups"].([]routeGroupSnapshot); len(groups) != 512 {
		t.Fatalf("complete policy-group count = %d", len(groups))
	}

	overflow, _, overflowGroups, err := parseConfig(configWithGroups(513))
	if err != nil {
		t.Fatalf("parse overflow fixture: %v", err)
	}
	overflowSnapshot := routesSnapshot(512, overflow.Proxies, overflow.General.Mode.String(), overflowGroups)
	if overflowSnapshot["truncated"] != true {
		t.Fatal("omitted policy group was not reported as truncated")
	}
}

func TestInvalidLimitsReturnTypedErrors(t *testing.T) {
	core := &coreRuntime{phase: phaseInactive, initialized: true}
	result := core.snapshot([]byte(`{"kind":"connections","limit":513}`))
	if result.status != statusLimitExceeded {
		t.Fatalf("status = %d", result.status)
	}
	envelope := decodeEnvelope(t, result)
	if envelope.Error == nil || envelope.Error.Code != "limit-exceeded" {
		t.Fatalf("unexpected error: %#v", envelope.Error)
	}
}

func TestRouteSelectionIsAuthoritativeIdempotentAndStaleSafe(t *testing.T) {
	core := &coreRuntime{phase: phaseInactive}
	if result := core.initialize([]byte(`{"abiVersion":1}`), func(int) error { return nil }); result.status != statusOK {
		t.Fatalf("initialize: %s", result.payload)
	}
	if result := core.loadConfig([]byte(routeConfig)); result.status != statusOK {
		t.Fatalf("load: %s", result.payload)
	}
	executor.ApplyConfig(core.loaded, true)
	t.Cleanup(executor.Shutdown)
	core.phase = phaseRunning
	core.session = "session-a"
	core.lifecycle = &lifecycleAuthority{
		MachineAuthority: "runtime-a", ScopeEpoch: 1, OperationID: "start-a",
		AdmittedRevision: 1, EffectIdentity: "1",
	}

	command := []byte(`{"operation":"select-policy","operationId":"route-a","runtimeAuthority":"runtime-a","profileId":"profile-a","profileRevision":"revision-a","groupId":"group:stable","currentChildId":"proxy:direct","childId":"proxy:reject","group":"Proxy","currentChild":"DIRECT","selection":"REJECT"}`)
	if result := core.command(command); result.status != statusOK {
		t.Fatalf("select: %s", result.payload)
	}
	selectedSequence := core.sequence
	if result := core.command(command); result.status != statusOK {
		t.Fatalf("duplicate: %s", result.payload)
	}
	if core.sequence != selectedSequence {
		t.Fatalf("duplicate mutated sequence: %d != %d", core.sequence, selectedSequence)
	}

	conflict := []byte(`{"operation":"select-policy","operationId":"route-a","runtimeAuthority":"runtime-a","profileId":"profile-a","profileRevision":"revision-a","groupId":"group:stable","currentChildId":"proxy:direct","childId":"proxy:direct","group":"Proxy","currentChild":"DIRECT","selection":"DIRECT"}`)
	if result := core.command(conflict); result.status != statusConflict {
		t.Fatalf("identity conflict status = %d", result.status)
	}
	stale := []byte(`{"operation":"select-policy","operationId":"route-stale","runtimeAuthority":"runtime-old","profileId":"profile-a","profileRevision":"revision-a","groupId":"group:stable","currentChildId":"proxy:reject","childId":"proxy:direct","group":"Proxy","currentChild":"REJECT","selection":"DIRECT"}`)
	if result := core.command(stale); result.status != statusConflict {
		t.Fatalf("stale authority status = %d", result.status)
	}
	snapshot := core.snapshot([]byte(`{"kind":"routes","limit":512}`))
	if snapshot.status != statusOK || !strings.Contains(string(snapshot.payload), `"selected":"REJECT"`) {
		t.Fatalf("authoritative routes snapshot: %s", snapshot.payload)
	}
	if core.sequence != selectedSequence {
		t.Fatalf("rejected commands mutated sequence: %d != %d", core.sequence, selectedSequence)
	}
}

func TestClosedConnectionIdentifierAndInactiveMutationFailClosed(t *testing.T) {
	for _, identifier := range []string{"connection-a", "A_1.stable"} {
		if !validConnectionID(identifier) {
			t.Fatalf("expected %q to be a valid stable ID", identifier)
		}
	}
	for _, identifier := range []string{"", "connection/a", strings.Repeat("a", 129)} {
		if validConnectionID(identifier) {
			t.Fatalf("expected %q to be rejected", identifier)
		}
	}
	core := &coreRuntime{phase: phaseInactive, initialized: true}
	request := []byte(`{"connectionId":"connection-a","eventSequence":"1","sessionId":"session-a"}`)
	if result := core.closeConnection(request); result.status != statusConflict {
		t.Fatalf("inactive close status = %d", result.status)
	}
}
