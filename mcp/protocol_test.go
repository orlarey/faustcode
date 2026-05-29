package main

import "testing"

func TestCompareContractVersions(t *testing.T) {
	tests := []struct {
		name   string
		webapp string
		mcp    string
		want   ContractCompat
	}{
		// NW-3..NW-5 ladder
		{"identical patch", "1.2.3", "1.2.3", ContractOK},
		{"same major.minor different patch", "1.2.3", "1.2.7", ContractOK},
		{"minor up", "1.3.0", "1.2.0", ContractMinorMismatch},
		{"minor down", "1.2.0", "1.3.0", ContractMinorMismatch},
		{"major up", "2.0.0", "1.0.0", ContractMajorMismatch},
		{"major down", "1.0.0", "2.0.0", ContractMajorMismatch},
		{"major + minor diverge", "2.5.0", "1.3.0", ContractMajorMismatch},
		{"pre-release on one side", "1.0.0-rc1", "1.0.0", ContractOK},
		{"webapp empty", "", "1.0.0", ContractUnparsable},
		{"mcp empty", "1.0.0", "", ContractUnparsable},
		{"both garbled", "x.y.z", "?.?.?", ContractUnparsable},
	}
	for _, tc := range tests {
		got := CompareContractVersions(tc.webapp, tc.mcp)
		if got != tc.want {
			t.Errorf("%s : CompareContractVersions(%q, %q) = %d, want %d",
				tc.name, tc.webapp, tc.mcp, got, tc.want)
		}
	}
}

func TestParseSemVer(t *testing.T) {
	tests := []struct {
		in       string
		want     SemVer
		wantErr  bool
	}{
		{"0.0.0", SemVer{0, 0, 0}, false},
		{"1.2.3", SemVer{1, 2, 3}, false},
		{"10.20.30", SemVer{10, 20, 30}, false},
		{"1.0.0-rc1", SemVer{1, 0, 0}, false},
		{"2.5.7-dev.4", SemVer{2, 5, 7}, false},
		{"1.0.0+build42", SemVer{1, 0, 0}, false},
		{"1.0.0-rc1+build42", SemVer{1, 0, 0}, false},

		{"", SemVer{}, true},
		{"1", SemVer{}, true},
		{"1.2", SemVer{}, true},
		{"1.2.3.4", SemVer{}, true},
		{"a.b.c", SemVer{}, true},
		{"1.x.3", SemVer{}, true},
		{"v1.2.3", SemVer{}, true}, // no leading 'v'
	}
	for _, tc := range tests {
		got, err := ParseSemVer(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("ParseSemVer(%q) = %+v, want error", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseSemVer(%q) unexpected error: %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("ParseSemVer(%q) = %+v, want %+v", tc.in, got, tc.want)
		}
	}
}
