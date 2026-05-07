package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/dialect"
)

type ChannelMessage struct {
	ent.Schema
}

func (ChannelMessage) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.String("client_message_id").Unique(),
		field.String("cipher_text").SchemaType(map[string]string{dialect.MySQL: "mediumtext"}),
		field.String("iv"),
		field.String("auth_tag"),
		field.Time("sent_at").Default(time.Now),
	}
}

func (ChannelMessage) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("sender", User.Type).
			Ref("channel_messages_sent").
			Unique().
			Required(),
		edge.From("channel", Channel.Type).
			Ref("channel_messages").
			Unique().
			Required(),
	}
}
