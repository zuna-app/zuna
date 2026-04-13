package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"github.com/nrednav/cuid2"
)

// User holds the schema definition for the User entity.
type User struct {
	ent.Schema
}

// Fields of the User.
func (User) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").DefaultFunc(func() string {
			return cuid2.Generate()
		}),
		field.String("username").Unique(),
		field.Bytes("identity_key").Unique(),
		field.Bytes("signing_key").Unique(),
		field.Time("last_seen").Default(time.Now),
		field.Bool("is_admin").Default(false),
		field.Bytes("avatar").Default([]byte{}),
		field.Bytes("avatar_iv").Default([]byte{}),
		field.Bytes("avatar_auth_tag").Default([]byte{}),
	}
}

// Edges of the User.
func (User) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("chats", Chat.Type),
		edge.To("messages", Message.Type),
	}
}
