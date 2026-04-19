package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
)

// Message holds the schema definition for the Message entity.
type Message struct {
	ent.Schema
}

// Fields of the Message.
func (Message) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.String("cipher_text").SchemaType(map[string]string{dialect.MySQL: "mediumtext"}),
		field.String("iv"),
		field.String("auth_tag"),
		field.Time("sent_at").Default(time.Now),
		field.Time("read_at").Nillable().Optional().Default(nil),
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

		edge.To("attachment", Attachment.Type).Unique(),
	}
}
