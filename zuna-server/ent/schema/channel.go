package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"github.com/nrednav/cuid2"
)

type Channel struct {
	ent.Schema
}

func (Channel) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").DefaultFunc(func() string {
			return cuid2.Generate()
		}),
		field.String("name"),
		field.Bool("is_public").Default(false),
		field.String("channel_type").Default("text"),
		field.Time("created_at").Default(time.Now),
	}
}

func (Channel) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("owner", User.Type).
			Ref("owned_channels").
			Unique().
			Required(),
		edge.To("channel_members", ChannelMember.Type),
		edge.To("channel_messages", ChannelMessage.Type),
		edge.To("group_keys", GroupKey.Type),
	}
}
