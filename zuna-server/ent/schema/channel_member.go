package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
	"github.com/nrednav/cuid2"
)

type ChannelMember struct {
	ent.Schema
}

func (ChannelMember) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").DefaultFunc(func() string {
			return cuid2.Generate()
		}),
		field.Time("joined_at").Default(time.Now),
	}
}

func (ChannelMember) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("channel", Channel.Type).
			Ref("channel_members").
			Unique().
			Required(),
		edge.From("user", User.Type).
			Ref("channel_memberships").
			Unique().
			Required(),
	}
}

func (ChannelMember) Indexes() []ent.Index {
	return []ent.Index{
		index.Edges("channel", "user").Unique(),
	}
}
