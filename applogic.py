from models import session_manager
from utils import abort, inoutlogger
import models
import snapshot
import logging
import config

log = logging.getLogger(__name__)

@inoutlogger
def valid_facebook_ids(Session, facebook_id_string):
    """Returns the valid facebook_ids from a list of players"""

    if facebook_id_string is  None:
        return []

    uids = []
    facebook_ids = facebook_id_string.split(',')
    for fid in facebook_ids:
        success, uid = models.User._get_userid_from_facebookid(Session, fid)
        if not success:
            message = "can't find account for facebook_id %s " % fid
            abort(409, message=message)
        else:
            uids.append(uid)

    return uids

@inoutlogger
def valid_emails(Session, email_string):
    """Returns the valid emails from a list of player emails"""

    if email_string is None:
        return []

    uids = []
    emails = emails_string.split(',')
    for email in emails:
        uid = models.User._get_userid_from_email(Session, email)
        if not success:
            message = "can't find account for email %s " % email
            abort(409, message=message)
        else:
            uids.append(uid)

    return uids

@inoutlogger
def has_valid_players(uids):
    """Valides there are enough players without duplicates"""

    if len(uids) < config.min_players:
        message = "Not enough players: %s" % repr(uids)
        log.error(message)
        abort(409, message=message)

    if len(uids) != len(set(uids)):
        message = "User_id %d has invited duplicate users: %s" \
                  % (my_uid, repr(uids))
        log.error(message)
        abort(409, message=message)

    return True

def is_valid_haiku(haiku):
    """Returns true if haiku is valid"""

    if len(haiku) < config.min_poem_length:
        message = "Haiku is too short"
        abort(409, message=message)

    return True

def is_valid_player(uid, snap):
    """Returns True if the given uid is a player in the game"""

    if not snapshot.is_playing_game(uid, snap):
        message = "User %d is not in game_id %d" % (uid, snap['game_id'])
        log.error(message)
        abort(409, message=message)

    return True

def is_not_abandonded_game(snap):
    """Returns True if the snap is from an abandoned game"""

    if snap['stage'] == "Abandoned":
        message="Abandoned game, not enough players"
        log.debug(message)
        abort(411, message=message)

    return True


@inoutlogger
def has_right_to_submit_topic(uid, snap):
    """Validates that the user has right to submit topic"""

    is_valid_player(uid, snap)
    is_not_abandonded_game(snap)

    if snap['topic_picker_id'] != uid:
        message = "User %d is not topic picker in game_id %d" % (
                                  uid, snap['game_id'])
        log.error(message)
        abort(409, message=message)

    stage = snap['stage']
    if stage != "Results" and stage != "Winner":
        message = "at stage %s instead of Results/Winner" % stage
        response['message'] = message
        log.error(message)
        abort(409, message=message)

    return True

@inoutlogger
def has_right_to_vote(uid, snap, vote):
    """Validates that the user has right to vote"""

    is_valid_player(uid, snap)
    is_not_abandonded_game(snap)

    stage = snap['stage']
    if stage != "Vote":
        message = "uid %d tried to vote game_id %d" \
                  " in stage %s" % (uid, snap['game_id'], stage)
        log.error(message)
        abort(409, message=message)

    if not snapshot.has_real_poem(snap, vote):
        message = "Invalid vote - player has no poem"
        log.error(message)
        abort(409, message=message)

    return True

@inoutlogger
def has_right_to_write(uid, snap):
    """Validates that the user has right to write a haiku"""

    is_valid_player(uid, snap)
    is_not_abandonded_game(snap)

    stage = snap['stage']
    if stage != "Write":
        message = "uid %d tried to write a poem for game_id %d" \
                  " in stage %s" % (uid, snap['game_id'], stage)
        log.error(message)
        abort(409, message=message)

    return True

def round_over(snap):
    """Returns true if stage is Results or Winner"""

    return snap['stage'] == "Results" or snap['stage'] == "Winner"

def progress_games(Session, user_id, snaps):
    """ 
    Iterates through the list of game and checks to see if the deadline
    for the stage has expired. If so, the game is progressed to the next
    stage, such as from writing haikus to voting for haikus.
    """

    i=0 
    new_snaps = []
    for snap in snaps:
        log.debug("Checking game %d with game_id %d", i, snap['game_id'])
        if not snapshot.should_progress_stage(snap, user_id):
            i += 1
            continue

        if snap['stage'] == "Write":
            success, new_snap = models.Game.progress_from_write(
                                        Session, snap['game_id'])
            snaps[i] = new_snap
        elif snap['stage'] == "Vote":
            success, new_snap = models.Game.progress_from_vote(
                                        Session, snap['game_id'])
            snaps[i] = new_snap

        # this is where we get a new game created after progressing
        elif snap['stage'] == "Results" or snap['stage'] == "Winner":
            success, new_game_snap = models.Game.clone(
                    Session, snap['game_id'], 0, None, None)
            if success:
                snaps[i]['next_id'] = new_game_snap['game_id']
                new_snaps.append(new_game_snap)
        i += 1

    for new_game in new_snaps:
        snaps.append(new_game)

    return snaps
