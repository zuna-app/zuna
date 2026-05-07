package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
	"github.com/nrednav/cuid2"
)

type GroupKey struct {
	ent.Schema
}

func (GroupKey) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").DefaultFunc(func() string {
			return cuid2.Generate()
		}),
		field.String("encrypted_key"),
		field.String("iv"),
		field.String("auth_tag"),
		field.Time("delivered_at").Nillable().Optional().Default(nil),
	}
}

func (GroupKey) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("channel", Channel.Type).
			Ref("group_keys").
			Unique().
			Required(),
		edge.From("recipient", User.Type).
			Ref("received_group_keys").
			Unique().
			Required(),
		edge.From("sender", User.Type).
			Ref("sent_group_keys").
			Unique().
			Required(),
	}
}

func (GroupKey) Indexes() []ent.Index {
	return []ent.Index{
		index.Edges("channel", "recipient").Unique(),
	}
}
