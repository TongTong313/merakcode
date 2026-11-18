package schema_test

import (
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/protocol/schema"
	first "github.com/TongTong313/merakcode/merak/protocol/schema/testdata/first/collision"
	second "github.com/TongTong313/merakcode/merak/protocol/schema/testdata/second/collision"
)

func TestDocumentRejectsTypesWithTheSameSchemaName(t *testing.T) {
	err := schema.WriteDocumentWithTypes(io.Discard, []reflect.Type{
		reflect.TypeFor[first.Record](),
		reflect.TypeFor[second.Record](),
	})
	if err == nil {
		t.Fatal("different Go types with the same schema name were accepted")
	}
	for _, name := range []string{
		"github.com/TongTong313/merakcode/merak/protocol/schema/testdata/first/collision.Record",
		"github.com/TongTong313/merakcode/merak/protocol/schema/testdata/second/collision.Record",
	} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("error %q does not name %s", err, name)
		}
	}
}
