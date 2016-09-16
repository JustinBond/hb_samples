from flask import Flask, request, make_response
from flask_restful import Api, Resource, reqparse, fields, \
        marshal, marshal_with
from flask_restful.representations.json import output_json
from database import Session
from utils import inoutlogger
from jsondef import json_status, json_receipt, json_login, json_anon_poem, json_player, \
        json_game, json_games, json_one_game
import os
import time
import models
import logging
import config
import snapshot
import sys
import applogic

# 
# App config
# 
reload(sys)
sys.setdefaultencoding('utf-8')

output_json.func_globals['settings'] = {'ensure_ascii': False,
                                        'encoding': 'utf8'}
app = Flask(__name__)
api = Api(app)

log = logging.getLogger(__name__)
log.debug("begin routes")

reqparser = reqparse.RequestParser()
reqparser.add_argument('access_token',
                       type=str,
                       required=True,
                       location="json")

# 
# Begin controllers here
#

class NewTopic(Resource):
    """Submit a topic, which also launches the next round of the game"""

    def __init__(self):

        self.games_parser = reqparser.copy()
        self.games_parser.add_argument('game_id', type=int, required=True,
                                       location="json")
        self.games_parser.add_argument('topic', type=str, required=True,
                                       location="json")
        self.games_parser.add_argument('haiku', type=str, required=True,
                                       location="json")

    
    @inoutlogger
    def put(self):
        """Submit a topic, which also launches the next round of the game"""

        args = self.games_parser.parse_args()
        uid = models.User.get_or_create(Session, args['access_token'], False)

        success, snap = models.Game.get_snap(Session, args['game_id'])
        applogic.has_right_to_submit_topic(uid, snap)
        applogic.is_valid_haiku(args['haiku'])
        new_game_snap = models.Game.clone(Session,
                                          args['game_id'],
                                          uid,
                                          args['topic'],
                                          args['haiku'])

        me_snap = snapshot.set_me_in_snap(new_game_snap, uid)
        agames = snapshot.anonymize(uid, [me_snap])
        anon_snap = agames[0]

        response = {
                'status'  : 202,
                'game'    : anon_snap,
                'message' : "Submitted new topic"
        }
        return marshal(response, json_one_game)


class Vote(Resource):
    """vote for a poem"""

    def __init__(self):
        self.games_parser = reqparser.copy()
        self.games_parser.add_argument('vote', type=int, required=True,
                                       location="json")
        self.games_parser.add_argument('game_id', type=int, required=True,
                                       location="json")

    @inoutlogger
    def put(self):
        """vote for a poem"""

        args = self.games_parser.parse_args()
        uid = models.User.get_or_create(Session, args['access_token'], False)

        success, snap = models.Game.get_snap(Session, args['game_id'])
        applogic.has_right_to_vote(uid, snap, args['vote'])
        new_snap = models.PlayerInfo.set_vote(Session, uid, args['game_id'],
                                                            args['vote'])

        if new_snap is not None and applogic.round_over(new_snap):

            me_snap = snapshot.set_me_in_snap(new_snap, uid)
            agames = snapshot.anonymize(uid, [me_snap])
            anon_snap = agames[0]

            response = {
                    'status'  : 202,
                    'message' :  "success",
                    'game'    : anon_snap
            }
            return marshal(response, json_one_game)

        response = {
                'status'  : 202,
                'message' :  "success",
        }
        return marshal(response, json_status)


class NameGame(Resource):

    def __init__(self):
        self.games_parser = reqparser.copy()
        self.games_parser.add_argument('game_id', type=int, required=True,
                                       location="json")
        self.games_parser.add_argument('name', type=str, required=True,
                                       location="json")

    @inoutlogger
    def put(self):
        """Names a game"""

        args = self.games_parser.parse_args()

        uid = models.User.get_or_create(Session, args['access_token'], False)
        _, snap = models.Game.get_snap(Session, args['game_id'])
        applogic.is_valid_player(uid, snap)
        success, message = models.Game.name_game(Session,
                                                 args['game_id'],
                                                 args['name'])

        response = {
                'status'  : 200,
                'message' : message
        }
        return marshal(response, json_status)


class Write(Resource):

    def __init__(self):
        self.games_parser = reqparser.copy()
        self.games_parser.add_argument('poem', type=str, required=True,
                                       location="json")
        self.games_parser.add_argument('game_id', type=int, required=True,
                                       location="json")

    @inoutlogger
    def put(self):
        """Adds a poem to the game"""

        args = self.games_parser.parse_args()
        uid = models.User.get_or_create(Session, args['access_token'], False)

        applogic.is_valid_haiku(args['poem'])
        success, snap = models.Game.get_snap(Session, args['game_id'])
        applogic.has_right_to_write(uid, snap)
        applogic.is_valid_haiku(args['poem'])
        new_snap = models.PlayerInfo.write(Session,
                                           uid,
                                           args['game_id'],
                                           args['poem'])


        # A new snap is only set if player was last to vote and stage is 
        # now for voting. So a new_snap of none means just acknowledge
        # the write
        if new_snap is None:
            response = {
                    'status'  :  200,
                    'message' : "Submitted poem"
            }
            return marshal(response, json_status)

        stage = new_snap['stage']
        me_snap = snapshot.set_me_in_snap(new_snap, uid)
        agames = snapshot.anonymize(uid, [me_snap])
        anon_snap = agames[0]
        response = {
                'status'  : 200,
                'message' : "Submitted poem",
                'game'    : anon_snap
        }
        return marshal(response, json_one_game)


class Remove(Resource):
    """Quit a game"""

    def __init__(self):
        self.games_parser = reqparser.copy()
        self.games_parser.add_argument('game_id', type=int, required=True,
                                       location="json")

    @inoutlogger
    def put(self):
        """Quit a game"""

        args = self.games_parser.parse_args()
        uid = models.User.get_or_create(Session, args['access_token'], False)

        _, snap = models.Game.get_snap(Session, args['game_id'])
        applogic.is_valid_player(uid, snap)
        _, message = models.Game.remove_player(Session, uid, args['game_id'])

        reponse = {
                'status'  : 200,
                'message' : message
        }
        return marshal(response, json_status)


class MyGames(Resource):
    """"Gets the user's list of games"""

    def __init__(self):
        self.games_parser = reqparser.copy()

    @inoutlogger
    def put(self):
        """"Gets the user's list of games"""

        args = self.games_parser.parse_args()
    
        uid = models.User.get_or_create(Session, args['access_token'], False)

        snaps, unlocked, poems_left = models.User.list_games(Session, uid)
        prog_snaps = applogic.progress_games(Session, uid, snaps)
        me_snaps = snapshot.set_me_in_snaps(prog_snaps, uid)
        anon_snaps = snapshot.anonymize(uid, me_snaps)

        response = {
            'status'     : 200,
            'message'    : "success",
            'game_count' : len(anon_snaps),
            'games'      : anon_snaps,
            'unlocked'   : unlocked,
            'poems_left' : poems_left

        }
        return marshal(response, json_games)


class NewGame(Resource):
    """Create a new game"""

    def __init__(self):
        """Define arguments for this class"""

        self.games_parser = reqparser.copy()
        self.games_parser.add_argument('topic', type=str, required=True,
                                       location="json")
        self.games_parser.add_argument('haiku', type=str, required=True,
                                       location="json")
        self.games_parser.add_argument('facebook_ids',
                                       type=str,
                                       location="json")
        self.games_parser.add_argument('emails', type=str, location="json")

    @inoutlogger
    def put(self):
        """Creates a new game"""

        args = self.games_parser.parse_args()

        # build up the list of users in the game, starting with the creator
        uids = []
        my_uid = models.User.get_or_create(Session, args['access_token'], False)
        uids.append(my_uid)

        uids += applogic.valid_facebook_ids(Session, args['facebook_ids'])
        uids += applogic.valid_emails(Session, args['emails'])

        applogic.has_valid_players(uids)
        applogic.is_valid_haiku(args['haiku'])

        snap = models.Game.create(Session, my_uid, args['topic'], args['haiku'], uids)

        me_snap = snapshot.set_me_in_snap(snap, my_uid)

        response = { 
                'status'  : 202,
                'message' : "Game created successfully",
                'game'    : me_snap
        }

        return marshal(response, json_one_game)


class ChangeUserName(Resource):
    """Change username"""

    @inoutlogger
    def put(self):
        args = reqparser.parse_args(strict=True)
        logging.debug("parsed args")
        access_token = args['access_token']

        uid = models.User.get_or_create(Session, access_token, False)

        _, profile = models.User._get_profile_from_facebook(access_token)
        message = models.User.change_name(Session, uid, profile['name'])

        response = {
                'status'   : 200,
                'message'  : message
        }
        return marshal(response, json_status)


class Login(Resource):
    """Login and create a user (if necessary) based on Facebook access token"""

    @inoutlogger
    def put(self):
        args = reqparser.parse_args(strict=True)
        uid = models.User.get_or_create(Session, args['access_token'])

        unlocked, poems_left = models.User.get_purchase_status(Session, uid)

        response = {
                'status'      : 200,
                'user_id'     : str(uid), 
                'unlocked'    :  unlocked,
                'haikus_left' : poems_left
        }
        return marshal(response, json_login)

api.add_resource(NameGame,
                 '/slam/api/v1/games/name',
                 endpoint='slam/api/v1/games/name')
api.add_resource(NewTopic,
                 '/slam/api/v1/games/topic',
                 endpoint='slam/api/v1/games/topic')
api.add_resource(Vote,
                 '/slam/api/v1/games/vote',
                 endpoint='slam/api/v1/games/vote')
api.add_resource(Write,
                 '/slam/api/v1/games/write',
                 endpoint='slam/api/v1/games/write')
api.add_resource(Remove,
                 '/slam/api/v1/games/remove',
                 endpoint='slam/api/v1/games/remove')
api.add_resource(NewGame,
                 '/slam/api/v1/games/new',
                 endpoint='slam/api/v1/games/new')
api.add_resource(MyGames,
                 '/slam/api/v1/games/me',
                 endpoint='slam/api/v1/games/me')
api.add_resource(Login,
                 '/slam/api/v1/login',
                 endpoint='slam/api/v1/login')
api.add_resource(UnlockIOS,
                 '/slam/api/v1/games/unlock',
                 endpoint='slam/api/v1/games/unlock')
api.add_resource(UnlockAndroid,
                 '/slam/api/v1/games/unlockAndroid',
                 endpoint='slam/api/v1/games/unlockAndroid')


if __name__ == '__main__':
    log.debug("running in debug mode")
    app.run(debug=True)
#    app.run(host="0.0.0.0", debug=False)
