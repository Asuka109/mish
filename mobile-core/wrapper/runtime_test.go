package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/metacubex/mihomo/config"
)

const fixtureConfig = `
mode: rule
log-level: warning
proxies: []
proxy-groups: []
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
	if _, _, err := parseConfig([]byte(fixtureConfig)); err != nil {
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
