package store

import (
	"context"
	"errors"
	"testing"
)

// What each part of the store says of something that isn't there, or can't be done to it.
func TestWhatIsntThere(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	nobody := NewID()
	yes, no := true, false
	owner := "owner"
	notFound := func(name string, err error) {
		t.Helper()
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s: %v, want not found", name, err)
		}
	}
	refused := func(name string, err error) {
		t.Helper()
		if err == nil {
			t.Errorf("%s was done", name)
		}
	}
	// Callers only ask these of accounts there are, so any refusal does.
	_, err := db.Account(ctx, nobody, nobody)
	refused("an account", err)
	_, _, _, err = db.Head(ctx, nobody)
	refused("an account's head", err)
	if slot, err := db.SlotOf(ctx, nobody, "password"); slot != nil || err != nil {
		t.Errorf("a slot: %v, %v", slot, err)
	}
	_, err = db.Group(ctx, nobody)
	notFound("a group", err)
	_, err = db.GroupKind(ctx, nobody)
	notFound("a group's kind", err)
	_, _, err = db.GroupInfo(ctx, nobody)
	notFound("a group's info", err)
	_, err = db.Sound(ctx, nobody)
	notFound("a sound", err)
	_, err = db.SessionByToken(ctx, []byte("nothing"))
	notFound("a session", err)
	_, err = db.DeviceKey(ctx, nobody)
	notFound("a device's key", err)
	notFound("someone's role", db.SetRole(ctx, nobody, "admin"))
	notFound("banning someone", db.BanUser(ctx, nobody, nobody))
	if _, err := db.UnbanUser(ctx, nobody); err != nil && !errors.Is(err, ErrNotFound) {
		t.Errorf("unbanning someone who isn't there: %v", err)
	}
	_, err = db.DeleteAccount(ctx, nobody)
	notFound("deleting an account", err)
	_, err = db.UpdateBot(ctx, nobody, &yes, &owner, &no)
	notFound("a bot", err)
	notFound("renewing a bot's setup", db.RenewBotSetup(ctx, nobody, "code", Now()))
	notFound("deleting a waiting bot", db.DeleteWaitingBot(ctx, nobody))
	_, err = db.SetBotChannels(ctx, nobody, nil)
	notFound("a bot's channels", err)
	_, err = db.UpdateProfile(ctx, nobody, []byte("p"), nil, nil)
	refused("someone's profile", err)
	notFound("reporting someone", db.AddReport(ctx, nobody, "spam"))
	notFound("joining a channel", db.JoinChannel(ctx, nobody, nobody, "member", []byte("p"), false))
	_, err = db.EditMessage(ctx, nobody, nobody, 1, []byte("e"), nil)
	notFound("editing a message", err)
	_, _, _, err = db.DeleteMessage(ctx, nobody, nobody, Deletion{Proof: []byte("d"), Epoch: 1}, nil)
	notFound("deleting a message", err)
	_, _, err = db.RemoveReaction(ctx, nobody, nobody, nobody, nil)
	refused("a reaction", err)
	_, _, err = db.AddReaction(ctx, nobody, nobody, Reaction{ID: NewID(), Data: []byte("r")}, nil)
	notFound("reacting", err)
	_, err = db.RemoveMember(ctx, nobody, nobody, nobody)
	notFound("removing someone", err)
	if promoted, _ := db.PromoteIfNoAdmin(ctx, nobody); promoted {
		t.Error("someone was promoted in no group")
	}
	if groups, err := db.UserGroups(ctx, nobody); len(groups) != 0 || err != nil {
		t.Errorf("nobody's groups: %v %v", groups, err)
	}
	if messages, err := db.MessagesAround(ctx, nobody, 5, 0, 10); len(messages) != 0 || err != nil {
		t.Errorf("messages around: %v %v", messages, err)
	}
	if changes, err := db.ChangesAfter(ctx, nobody, 0, 0, 10); err != nil || len(changes.Messages) != 0 {
		t.Errorf("changes: %v %v", changes, err)
	}
	if targets, err := db.PushTargets(ctx, nobody, true); len(targets) != 0 || err != nil {
		t.Errorf("push targets: %v %v", targets, err)
	}
	if registrations, err := db.PushRegistrationsOf(ctx, nil); len(registrations) != 0 || err != nil {
		t.Errorf("no one's registrations: %v %v", registrations, err)
	}
	refused("resealing nobody's vault", db.ResealVaultItems(ctx, nobody, 3, nil, nil))
	if (&GenerationConflictError{Current: 2}).Error() == "" {
		t.Error("a generation conflict says nothing")
	}
	if (&EpochConflictError{Current: 4}).Error() == "" {
		t.Error("an epoch conflict says nothing")
	}
}
