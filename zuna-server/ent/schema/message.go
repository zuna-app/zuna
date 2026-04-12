package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"github.com/nrednav/cuid2"
)

// Message holds the schema definition for the Message entity.
type Message struct {
	ent.Schema
}

// Fields of the Message.
func (Message) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").DefaultFunc(func() string {
			return cuid2.Generate()
		}),
		field.String("cipher_text").Nillable().SchemaType(map[string]string{dialect.MySQL: "mediumtext"}),
		field.String("iv").Nillable(),
		field.String("auth_tag").Nillable(),
		field.Time("sent_at").Default(time.Now),
		field.Time("read_at").Nillable(),
	}
}

// Edges of the Message.
func (Message) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("user", User.Type).
			Ref("messages").
			Unique().
			Required(),

		edge.From("chat", Chat.Type).
			Ref("messages").
			Unique().
			Required(),

		edge.To("attachments", Attachment.Type),
	}
}
