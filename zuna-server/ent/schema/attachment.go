package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"github.com/nrednav/cuid2"
)

// Attachment holds the schema definition for the Attachment entity.
type Attachment struct {
	ent.Schema
}

// Fields of the Attachment.
func (Attachment) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").DefaultFunc(func() string {
			return cuid2.Generate()
		}),
		field.String("metadata"),
		field.String("metadata_iv"),
		field.String("metadata_auth_tag"),
	}
}

// Edges of the Attachment.
func (Attachment) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("message", Message.Type).
			Ref("attachment").
			Unique(),
		edge.From("user", User.Type).
			Ref("attachments").
			Unique().Required(),
	}
}
