/*global angular*/
var mod = angular.module('SlamService', []);

mod.service('SlamLogin', ['config', '$localstorage', '$http', '$q', '$log', function (config, $localstorage, $http, $q, $log) {
    "use strict";

    this.getPoemsLeft = function () {
        return $localstorage.get('poemsLeft', null);
    };

    this.getUnlocked = function () {
        return $localstorage.get('unlocked', null) === "true";
    };

    this.getUserID = function () {
        return $localstorage.get('userID', null);
    };

    this.loggedIn = function () {
        return $localstorage.get('userID', null);
    };

    this.login = function (accessToken) {
        $log.debug("begin slam login with accessToken: ", accessToken);
        var deferred = $q.defer(),
            payload = {"access_token": accessToken};

        $http.put(config.loginURL, payload)
            .then(function (response) {
                $log.debug("Successful callback for login: ", response);
                if (response.data.status !== 200) {
                    $log.debug("invalid login: status: ", response.data.status);
                    deferred.reject(response);
                    return;
                }

                $log.debug("unlocked is: ", response.data.unlocked);
                $localstorage.set('poemsLeft', response.data.poems_left);
                $localstorage.set('unlocked', response.data.unlocked);
                $localstorage.set('userID', response.data.user_id);

                deferred.resolve(response);
            }, function (error) {
                $log.debug("Error connecting to slam server: ", error);
                deferred.reject(error);
            });

        return deferred.promise;
    };

    this.logout = function () {
        $log.debug("Begin logout");
        $localstorage.remove('poemsLeft');
        $localstorage.remove('unlocked');
        $localstorage.remove('userID');
        $log.debug("Finish logout with userID: ", $localstorage.get('userID', null));
    };
}]);

mod.service('SlamGameList', ['SlamGame', 'config', 'Notification', '$localstorage', '$http', '$q', '$log', function (SlamGame, config, Notification, $localstorage, $http, $q, $log) {

    "use strict";

    // Using JSLint as my linter so declaring all variables once at head of
    // function. A bit annoying but it did catch one case where Javascript's
    // lack of block scoping got me into trouble.
    var games,
        downloadTime,
        getGameIndexFromID,
        getGameFromList,
        postprocessGames,
        replaceOldVersionOfGame,
        restoreGameFromBackup,
        addOrReplace,
        dropPreviousGame,
        promoteNextGame,
        sortByActionItemsAndDeadline,
        getPrevGame,
        getPrevGameIndex,
        linkNextGames,
        setActionItems,
        setPlayerStages,
        setStageLabels,
        moveNextGames,
        parseGames,
        setDeadlineAges,
        removeGameFromList,
        secondsSinceEpoch;

    // the games variable is the client's "master list" of all the Haiku Boss
    // games the user is playing.
    games = [];
    downloadTime = 0.0;

    // Returns the list of games the user is playing
    this.getGameList = function () {
        return games;
    };

    // resets the user's data when logging out
    this.logout = function () {
        games = [];
        downloadTime = 0.0;
    };

    // convenience function. Returns the number of seconds since the UNIX EPOCH
    secondsSinceEpoch = function () {
        return Math.floor(Date.now() / 1000);
    };

    // downloads the user's list of games from the Haiku Boss server
    // Uses AngularJS promises
    this.downloadGames = function () {
        $log.debug("begin downloadGames");
        var deferred,
            message,
            payload,
            delta;

        deferred = $q.defer();

        // Don't download games again if they were recently downloaded
        delta = secondsSinceEpoch() - downloadTime;
        if (delta < config.checkInterval) {
            message = "last download only " + delta + " seconds ago, skipping download";
            $log.info(message);
            deferred.reject(message);
            return deferred.promise;
        }

        $log.info("last download was " + delta + " seconds ago - starting download");

        // Haiku Boss uses Facebook Connect for authentication so all the
        // Haiku Boss server sees is the user's Facebbok access token
        payload = {"access_token": $localstorage.get('accessToken')};
        $http.put(config.gamesURL, payload)
            .then(function (response) {
                $log.debug("Successful callback downloadGames: ", response);
                downloadTime = secondsSinceEpoch();
                parseGames(response);
                deferred.resolve(response);
            }, function (error) {
                $log.debug("Error callback connecting to slam server: ", error);
                deferred.reject(error);
            });
        return deferred.promise;
    };

    // Given the id number of a game, returns the index of that game in the
    // user's games array.
    getGameIndexFromID = function (id) {
        var i;
        for (i = 0; i < games.length; i += 1) {
            if (games[i].id === id) {
                return i;
            }
        }
        return null;
    };

    // Given the id number of a game, returns the reference to the game from
    // the master games array
    getGameFromList = function (id) {
        var i;
        for (i = 0; i < games.length; i += 1) {
            if (games[i].id === id) {
                return games[i];
            }
            if (games[i].nextGame === null) {
                continue;
            }
            if (games[i].nextGame.id === id) {
                return games[i].nextGame;
            }
        }
        return null;
    };

    // This needs to run whenever there is a significant change to the user's
    // games. Does things like set labels for display on the client, sort
    // games by whether or not the user has an "action item", and links
    // the next round of an ongoing game
    postprocessGames = function () {
        // Note: the order of these methods is important
        linkNextGames();
        games.sort(function (a, b) {return b.id - a.id; });
        setActionItems();
        setPlayerStages();
        setStageLabels();
        moveNextGames();
        sortByActionItemsAndDeadline();
        Notification.notify('download-games-event');
    };


  // This method is used when a game is moved to a new stage, such as from
  // writing a haiku to voting for a haiku. The server sends a lot of new
  // information so the old version of the game in the master games list is
  // replaced with the new version.
    replaceOldVersionOfGame = function (gameObject) {
        var newGame,
            prevGame,
            index;
        newGame = new SlamGame.buildGame(gameObject);
        // case 1: the old version is in the main game list
        index = getGameIndexFromID(newGame.id);
        if (index !== null) {
            $log.debug("Doing a replace with gameID: ", newGame.id);
            games[index] = newGame;
            return;
        }
        // case 2: the old version is a linked nextGame. In which case we'll
        // get the previous game and update the nextGame link
        prevGame = getPrevGame(newGame);
        if (prevGame !== null) {
            prevGame.nextGame = newGame;
        }
    };

    // Whenever the user takes an action, the client assumes that the action
    // will be successful and immediately makes the change locally. But if it
    // gets an error from the server, then it will undo the change.
    restoreGameFromBackup = function (backupGame) {
        var index,
            prevGame;

        // case 1: the old version is in the main game list
        index = getGameIndexFromID(backupGame.id);
        if (index !== null) {
            $log.debug("Doing a replace with gameID: ", backupGame.id);
            games[index] = backupGame;
            return;
        }
        // case 2: the old version is a linked nextGame. In which case we'll
        // get the previous game and update the nextGame link
        prevGame = getPrevGame(backupGame);
        if (prevGame !== null) {
            prevGame.nextGame = backupGame;
        }
    };

    // the main method for putting games into the master games list.
    addOrReplace = function (gameObject) {
        var newGame,
            index;

        newGame = new SlamGame.buildGame(gameObject);
        index = getGameIndexFromID(newGame.id);
        // if it's a new game
        if (index === null) {
            games.push(newGame);
        } else {
            // if we're replacing an existing game
            games[index] = newGame;
        }
        return newGame;
    };

    // In an ongoing game, players will go through cycles of writing new haikus
    // and voting for their favorite. These cycles are linked - the "old"
    // cycle is linked to the "new" cycle. But once a player has had a chance
    // to review the old cycle of a game, it is dropped.
    dropPreviousGame = function (game) {
        var prevGame = getPrevGame(game);
        if (prevGame !== null) {
            removeGameFromList(prevGame);
        }
    };

  // This method is called when a player performs and action such as writing
  // or voting. The results from the previous cycle are dropped and the
  // nextGame is moved onto the main list
    promoteNextGame = function (game) {
        var index = getPrevGameIndex(game);
        if (index !== null) {
            games[index] = game;
        }
    };

    // sorts the master games list by first action item and then by deadline
    sortByActionItemsAndDeadline = function () {
        games.sort(function (a, b) {
            // If you have an action item in both games, or in neither game, sort by deadline
            if ((a.me.actionItem && b.me.actionItem) && (!a.me.actionItem && !b.me.actionItem)) {
                return a.deadline > b.deadline;
            }
            // else, sort by action item
            return b.me.actionItem;
        });
    };

    // returns the previous game of a cycle of linked games
    getPrevGame = function (game) {
        $log.debug("Begin getPrevGame with gameID:", game.id);
        var i;
        for (i = 0; i < games.length; i += 1) {
            $log.debug("Checking gameID", games[i].id, "with nextID: ", games[i].nextID);
            if (games[i].nextID === game.id) {
                $log.debug("Found prevGame");
                return games[i];
            }
        }
        return null;
    };

    // returns the index in the master games list of the previous game
    getPrevGameIndex = function (game) {
        var i;
        for (i = 0; i < games.length; i += 1) {
            if (games[i].nextID === game.id) {
                return i;
            }
        }
        return null;
    };

    // in an ongoing game, players will go through many cycles of writing haikus
    // and then voting on them. These cycles are kept together by the nextGame
    // property which links the old cycle to the new cycle.
    linkNextGames = function () {
        $log.debug("Begin linkNextGames");
        var prevGame,
            i;

        for (i = 0; i < games.length; i += 1) {
            prevGame = getPrevGame(games[i]);
            if (prevGame !== null) {
                $log.debug("GameID: ", games[i].id, " has prevGame with gameID: ", prevGame.id);
                prevGame.nextGame = games[i];
            }
        }
    };

    // Sets the action items (writing a haiku, voting for a haiku) for the
    // player's games
    setActionItems = function () {
        var i;
        for (i = 0; i < games.length; i += 1) {
            $log.debug("Setting action items for gameID: ", games[i].gameID);
            games[i].setActionItem();
        }
    };

    // The user can go to a "scoreboard" view where they can see the score (duh)
    // as well as whether or not the other players have finished writing their
    // haikus (or voting, etc.) This information is set here.
    setPlayerStages = function () {
        var i;
        for (i = 0; i < games.length; i += 1) {
            games[i].setPlayerStages();
        }
    };

    // This sets the label for the stage of the game (writing, voting, reviewing
    // reviewing the results, etc.)
    setStageLabels = function () {
        var i;
        for (i = 0; i < games.length; i += 1) {
            games[i].setStageLabel();
        }
    };

    // this method removes the "nextGames" from the master games list since they
    // are accessed via the parent game's nextGame property
    moveNextGames = function () {
        var nextIndex,
            i;

        for (i = 0; i < games.length; i += 1) {
            if (games[i].nextGame !== null) {
                $log.debug("gameID: ", games[i].id, " has nextGame with id: ", games[i].nextGame.id);
                nextIndex = getGameIndexFromID(games[i].nextGame.id);
                $log.debug("nextIndex is: ", nextIndex);
                if (nextIndex === null) {
                    $log.debug("Error: can't find index for gameID: ", games[i].nextGame);
                    continue;
                }
                games.splice(nextIndex, 1);
                i -= 1;
            }
        }
    };

    // Parses the JSON sent by the server
    parseGames = function (response) {
        var i;
        games = [];
        $localstorage.set('poemsLeft', response.data.poems_left);
        $localstorage.set('unlocked', response.data.unlocked);
        $log.debug("Unlocked is:", $localstorage.get('unlocked', null));
        for (i = 0; i < response.data.games.length; i += 1) {
            //$log.debug("Parsing game: ", response.data.games[i]);
            addOrReplace(response.data.games[i]);
        }
        postprocessGames();
        $log.debug("final games list: ", games);
    };

    // Sets the deadline labels for the games
    setDeadlineAges = function () {
        var i;
        for (i = 0; i < games.length; i += 1) {
            $log.debug("setting deadlines for game: ", games[i]);
            games[i].setDeadlineAge();
        }
    };
    this.setDeadlineAges = setDeadlineAges;

    // remove a game from the master games list.
    removeGameFromList = function (gameID) {
        var index = getGameIndexFromID(gameID);
        games.splice(index, 1);
    };

    // server call to rename a game
    this.renameGame = function (newName, game) {
        $log.debug("Begin renameGame for game: ", game);
        var deferred = $q.defer(),
            oldName = game.name,
            index = getGameIndexFromID(game.id),
            payload;

        game.name = newName;
        games[index].name = newName;

        payload = {"access_token": $localstorage.get('accessToken', null),
                       "game_id": game.id,
                       "name": newName};

        $http.put(config.renameURL, payload)
            .then(function (response) {
                $log.debug("Successful callback for rename: ", response);
                if (response.data.status !== 200) {
                    $log.debug("Error from server when attempting to rename game: ", response.data.status);
                    game.name = oldName;
                    deferred.reject(response);
                } else {
                    deferred.resolve(response);
                }
            }, function (error) {
                $log.debug("Error callback when attempting to rename game: ", error);
                game.name = oldName;
                deferred.reject(error);
            });

        return deferred.promise;
    };

    this.quit = function (game) {
        $log.debug("Begin quit with game: ", game);
        var deferred = $q.defer(),
            origList = games.slice(0),
            payload;

        removeGameFromList(game.id);

        payload = {"access_token": $localstorage.get('accessToken', null),
                      "game_id": game.id};

        $http.put(config.quitURL, payload)
            .then(function (response) {
                $log.debug("Successful callback for quit: ", response);
                if (response.data.status !== 200) {
                    $log.debug("Error from server when attempting to quit game: ", response.data.status);
                    games = origList;
                    Notification.notify("error-quitting-event");
                    deferred.reject(response);
                } else {
                    deferred.resolve(response);
                }
            }, function (error) {
                $log.debug("Error when attempting to quit game: ", error);
                games = origList;
                Notification.notify("error-quitting-event");
                deferred.reject(error);
            });
        return deferred.promise;
    };

    this.write = function (haiku, gameID) {
        $log.debug("Begin write with gameID: ", gameID);
        var deferred = $q.defer(),
            game,
            backupList,
            backupGame,
            payload;

        game = getGameFromList(gameID);
        $log.debug("continuing with game: ", game);

        // assume haiku submitted successfully and do the following:
        backupList = games.slice(0);         // in case we get error callback
        backupGame = angular.copy(game);      // in case we get error callback

        game.me.poem = "1";
        game.me.actionItem = false;
        game.setActionItem();
        game.setPlayerStages();
        promoteNextGame(game);
        postprocessGames();

        payload = {"access_token": $localstorage.get('accessToken', null),
                      "game_id": game.id,
                      "poem": haiku};

        $http.put(config.writeURL, payload)
            .then(function (response) {
                $log.debug("Successful callback for write: ", response);
                if (response.data.status === 200) {
                    $log.debug("Submitted haiku");
                    deferred.resolve(response);
                } else if (response.data.status === 202) {
                    $log.debug("Submitted haiku and moved to the vote stage");
                    replaceOldVersionOfGame(response.data.game);
                    postprocessGames();
                    deferred.resolve(response);
                }
            }, function (response) {
                $log.debug("Error callback from write: ", response);
                $log.debug("status code is: ", response.status);
                games = backupList;
                restoreGameFromBackup(backupGame);

                if (response.status === 413) {
                    $log.debug("Out of haikus");
                    Notification.notify('out-of-haikus-event');
                } else {
                    Notification.notify('error-writing-event');
                }
                deferred.reject(response);
            });
        return deferred.promise;
    };

    this.vote = function (gameID, fakeID) {
        $log.debug("Begin write with gameID: ", gameID);
        var deferred = $q.defer(),
            game,
            backupList,
            backupGame,
            payload;

        game = games[getGameIndexFromID(gameID)];

        // assume vote submitted successfully and do the following:
        backupList = games.slice(0);         // in case we get error callback
        backupGame = angular.copy(game);      // in case we get error callback
        game.me.actionItem = false;
        game.me.vote = String(fakeID);
        game.setActionItem();
        game.setPlayerStages();

        payload = {"access_token": $localstorage.get('accessToken', null),
                   "game_id": game.id,
                   "vote": fakeID};

        $http.put(config.voteURL, payload)
            .then(function (response) {
                $log.debug("Successful callback for vote: ", response);
                if (response.data.status === 200) {
                    $log.debug("Submitted haiku");
                    deferred.resolve(response);
                } else if (response.data.status === 202) {
                    $log.debug("Submitted haiku and moved to the results stage");
                    replaceOldVersionOfGame(response.data.game);
                    postprocessGames();
                    deferred.resolve(response);
                }
            }, function (error) {
                $log.debug("Error callback from vote: ", error);
                games = backupList;
                restoreGameFromBackup(backupGame);
                Notification.notify('error-voting-event');
                deferred.reject(error);
            });
        return deferred.promise;
    };

    // New Topic - this is what creates a new round of the game.
    // But we don't know the game id until the callback. At which point we can
    // add the new game to the master game list and drop the old game.
    this.topic = function (gameID, topic, haiku) {
        $log.debug("Begin topic with gameID: ", gameID);
        var deferred = $q.defer(),
            game,
            payload;

        game = games[getGameIndexFromID(gameID)];

        payload = {"access_token": $localstorage.get('accessToken', null),
                      "game_id": game.id,
                      "topic": topic,
                      "haiku": haiku};

        $http.put(config.topicURL, payload)
            .then(function (response) {
                $log.debug("Successful callback for topic: ", response);
                if (response.data.status === 202) {
                    $log.debug("Submitted haiku and moved to the results stage");
                    var nextGame = addOrReplace(response.data.game);
                    dropPreviousGame(nextGame);
                    postprocessGames();
                    deferred.resolve(response);
                    Notification.notify('download-games-event');
                }
            }, function (response) {
                $log.debug("Error callback from topic: ", response);

                if (response.status === 413) {
                    $log.debug("Out of haikus");
                    Notification.notify('out-of-haikus-event');
                } else {
                    Notification.notify('error-topic-event');
                }
                deferred.reject(response);
            });
        return deferred.promise;
    };


    this.newGame = function (playersCSV, topic, haiku) {
        $log.debug("Begin newGame with players: ", playersCSV);
        var deferred = $q.defer(),
            payload;


        payload = {"access_token": $localstorage.get('accessToken', null),
                   "topic": topic,
                   "haiku": haiku,
                   "facebook_ids": playersCSV};

        $http.put(config.newGameURL, payload)
            .then(function (response) {
                $log.debug("Successful callback for newGame: ", response);
                if (response.data.status === 202) {
                    $log.debug("Submitted haiku and moved to the results stage");
                    addOrReplace(response.data.game);
                    postprocessGames();
                    deferred.resolve(response);
                }
            }, function (response) {
                $log.debug("Error callback from topic: ", response);

                if (response.status === 413) {
                    $log.debug("Out of haikus");
                    Notification.notify('out-of-haikus-event');
                } else {
                    Notification.notify('error-topic-event');
                }
                deferred.reject(response);
            });
        return deferred.promise;
    };
}]);

mod.service('SlamGame', ['config', '$log', function (config, $log) {
    "use strict";

    var secondsSinceEpoch;

    secondsSinceEpoch = function () {
        return Math.floor(Date.now() / 1000);
    };

    function AnonPoem(poemObject) {
        this.fakeID = poemObject.fake_id;
        this.poem = poemObject.poem;
    }

    function Player(playerObject) {
        this.id = playerObject.user_id;
        this.facebookID = playerObject.facebook_id;
        this.fakeID = playerObject.fake_id;
        this.correctVoter = playerObject.correct_voter;
        this.me = playerObject.me;
        this.name = playerObject.name;
        if (playerObject.poem === "x") {
            this.poem = "Didn't write poem";
        } else {
            this.poem = playerObject.poem;
        }
        this.vote = playerObject.vote;
        this.numVotes = 0;
        this.roundScore = playerObject.round_score;
        this.roundWinner = playerObject.winner;
        this.roundWinLabel = null;
        this.gameScore = playerObject.score;
        this.gameWinner = false;
        this.gameWinLabel = null;

        this.actionItem = false;
        this.actionLabel = "Nothing (waiting for others)";
        this.actionColor = "Black";
        this.firstName = this.name.split(" ")[0];
        this.pic = "http://graph.facebook.com/" + this.facebookID + "/picture?type=normal";
    }

    this.buildGame = function Game(gameObject) {
        this.id = gameObject.game_id;
        this.nextID = gameObject.next_id;
        this.name = gameObject.name;
        this.topic = gameObject.topic;
        this.topicPicker = gameObject.topic_picker;
        this.topicPickerID = gameObject.topic_picker_id;
        this.isNewGame = gameObject['new'];
        this.stage = gameObject.stage;
        this.deadline = gameObject.deadline;
        this.deadlineStyle = "normal";
        this.nextGame = null;

        this.parsePlayers = function (playersObject) {
            var players,
                i;
            players = [];

            for (i = 0; i < playersObject.length; i += 1) {
                players.push(new Player(playersObject[i]));
            }
            players.sort(function (a, b) {return b.gameScore - a.gameScore; });
            this.players = players;
        };
        this.parsePlayers(gameObject.players);

        this.parseAnonPoems = function (anonPoemObject) {
            var anonPoems,
                i;

            anonPoems = [];

            for (i = 0; i < anonPoemObject.length; i += 1) {
                $log.debug("Parsing anonPoem: ", anonPoemObject[i]);
                anonPoems.push(new AnonPoem(anonPoemObject[i]));
            }
            this.anonPoems = anonPoems;
        };
        this.parseAnonPoems(gameObject.anon_poems);

        this.setMe = function () {
            var i;

            for (i = 0; i < this.players.length; i += 1) {
                if (this.players[i].me) {
                    this.me = this.players[i];
                }
            }
        };
        this.setMe();

        // Gives games a name based on the players' names, much like
        // iMessage conversations
        this.setiMessageName = function () {

            var maxLength,
                playerName,
                players,
                numPlayersLeft,
                playersOtherThanMe,
                gameName,
                i;

            numPlayersLeft = function (index) {
                return this.players.length - 1 - index;
            };

            playersOtherThanMe = function () {
                var otherPlayers;

                otherPlayers = [];
                for (i = 0; i < this.players.length; i += 1) {
                    if (!this.players[i].me) {
                        otherPlayers.push(this.players[i]);
                    }
                }
                return otherPlayers;
            };

            // Only set an iMessage-style name if the game doesn't have a given name
            if (this.name !== null) {
                $log.debug("already has a name");
                return this.name;
            }
            // Handle the trivial cases
            if (this.players.length === 0) {
                this.name = "No players";
                return;
            }
            if (this.players.length === 1) {
                playerName = this.players[0].name;
                if (playerName === null || playerName === "") {
                    this.name = "Unknown player";
                } else {
                    this.name = this.players[0].name;
                }
                return;
            }

            // somewhat less trivial cases
            maxLength = config.maxGameNameLength - 8;
            players = playersOtherThanMe();
            if (players.length === 1) {
                $log.debug("One other player");
                this.name = players[0].name;
                return;
            }

            // onto the main cases
            numPlayersLeft = 0;
            gameName = playersOtherThanMe()[0].firstName;
            for (i = 1; i < this.players.length; i += 1) {
                numPlayersLeft = numPlayersLeft(i);
                if (numPlayersLeft === 1) {
                    gameName += " & " + playersOtherThanMe()[playersOtherThanMe().length - 1].firstName;
                    this.name = gameName;
                    return;
                }
                if (gameName.length >= maxLength) {
                    gameName += " & " + numPlayersLeft(i) + " more";
                    this.name = gameName;
                    return;
                }
                gameName += ", " + playersOtherThanMe()[i].firstName;
            }
            this.name = gameName;
        };
        this.setiMessageName();

        this.setVoters = function () {
            var player,
                votesByFakeID,
                i;

            if (this.stage !== "Results" && this.stage !== "Winner") {
                return;
            }

            this.votesByFakeID = function () {
                $log.debug("Begin with this: ", this);
                var votes = [];
                for (i = 0; i < this.players.length; i += 1) {
                    votes[i] = [];
                }
                for (i = 0; i < this.players.length; i += 1) {
                    player = this.players[i];
                    if (player.vote === -2) {
                        continue;
                    }
                    votes[player.vote].push(player.firstName);
                }
                return votes;
            };

            votesByFakeID = this.votesByFakeID();

            for (i = 0; i < this.players.length; i += 1) {
                player = this.players[i];
                switch (votesByFakeID[player.fakeID].length) {
                case 0:
                    player.votersLabel = "No votes";
                    break;
                case 1:
                    player.votersLabel = "1 vote: " + votesByFakeID[player.fakeID].join(", ");
                    break;
                default:
                    player.votersLabel = votesByFakeID[player.fakeID].length + " votes: " + votesByFakeID[player.fakeID].join(", ");
                }
            }
        };
        this.setVoters();

        this.setRoundLabel = function () {
            var roundWinnerLabel,
                winners,
                player,
                i;

            this.getWinners = function () {
                winners = [];
                for (i = 0; i < this.players.length; i += 1) {
                    player = this.players[i];
                    if (player.roundWinner) {
                        winners.push(player.fakeID);
                    }
                }
                return winners;
            };
            winners = this.getWinners();

            roundWinnerLabel = "Round winner";
            if (winners.length > 1) {
                roundWinnerLabel = "Round winner (tied)";
            }
            for (i = 0; i < this.players.length; i += 1) {
                player = this.players[i];
                if (player.roundWinner) {
                    player.roundWinnerLabel = roundWinnerLabel;
                    if (winners.length > 1 && winners.indexOf(player.vote) > -1) {
                        player.roundWinnerLabel += ", picked winner";
                    }
                } else if (winners.indexOf(player.vote) > -1) {
                    player.roundWinnerLabel = "Picked winner";
                }
            }
        };
        this.setRoundLabel();

        this.setStageLabel = function () {
            if (this.nextGame !== null && this.nextGame.stage === "Abandoned") {
                this.stageLabel = "Abandoned - many players quit";
                return;
            }

            if (this.stage === "Results") {
                this.stageLabel = "The votes are in!";
            } else if (this.stage === "Winner") {
                this.stageLabel = "The votes are in - we have a winner!";
            } else if (this.stage === "Abandoned") {
                this.stageLabel = "Abandoned - many players quit";
            } else {
                this.stageLabel = "Stage: " + this.stage;
            }

        };

        this.setGameWinners = function () {
            $log.debug("Begin setGameWinners");

            var highScore = config.winningScore,
                player,
                index,
                winners,
                i;

            winners = [];

            this.getPlayerIndexByID = function (id) {
                for (i = 0; i < this.players.length; i += 1) {
                    if (this.players[i].id === id) {
                        return i;
                    }
                }
            };

            for (i = 0; i < this.players.length; i += 1) {
                player = this.players[i];
                if (player.gameScore === highScore) {
                    $log.debug("Adding the following userID to winners: ", player.id);
                    winners.push(player.id);
                } else if (player.gameScore > highScore) {
                    $log.debug("Adding the following userID to winners: ", player.id);
                    winners = [player.id];
                }
            }
            for (i = 0; i < winners.length; i += 1) {
                index = this.getPlayerIndexByID(winners[i]);
                this.players[index].gameWinner = true;
                if (winners.length === 1) {
                    this.players[index].gameWinLabel = "Game winner!";
                } else {
                    this.players[index].gameWinLabel = "Game winner (tied)";
                }
            }
        };
        this.setGameWinners();

        //Mark: methods are called by SlamGameList
        this.setActionItem = function () {

            this.me.actionItem = false;
            this.me.actionLabel = "Nothing (waiting for others)";
            this.me.actionColor = "Black";

            if (this.stage === "Write" && this.me.poem === null) {
                this.me.actionItem = true;
                this.me.actionLabel = "Write haiku";
                this.me.actionColor = "DarkOrange";
            } else if (this.stage === "Vote" && this.me.vote === -1) {
                this.me.actionItem = true;
                this.me.actionLabel = "Vote";
                this.me.actionColor = "DarkOrange";
            } else if (this.stage === "Results" || this.stage === "Winner") {
                if (this.nextGame === null && this.topicPickerID === this.me.id) {
                    this.me.actionItem = true;
                    this.me.actionLabel = "Choose topic";
                    this.me.actionColor = "DarkOrange";
                } else if (this.nextGame === null && this.topicPickerID !== this.me.id) {
                    this.me.actionItem = false;
                    this.me.actionLabel = "Nothing (waiting for new topic)";
                    this.me.actionColor = "Black";
                } else if (this.nextGame !== null) {
                    this.me.actionItem = this.nextGame.me.actionItem;
                    this.me.actionLabel = this.nextGame.me.actionLabel;
                    this.me.actionColor = this.nextGame.me.actionColor;
                }
            } else if (this.stage === "Abandoned") {
                this.me.actionItem = false;
                this.me.actionLabel = "Swipe left to quit game";
                this.me.actionColor = "DarkOrange";
            }
        };

        this.setPlayerStages = function () {
            var player,
                nextPlayer,
                i,
                j;
            $log.debug("Begin setPlayerStages");
            for (i = 0; i < this.players.length; i += 1) {
                player = this.players[i];

                if (this.stage === "Write") {
                    if (player.poem === null) {
                        player.stageLabel = "Write Haiku: Incomplete";
                        player.stageColor = "DarkOrange";
                    } else {
                        player.stageLabel = "Write Haiku: Complete";
                        player.stageColor = "Black";
                    }
                } else if (this.stage === "Vote") {
                    if (player.vote === -1) {
                        player.stageLabel = "Vote for Haiku: Incomplete";
                        player.stageColor = "DarkOrange";
                    } else {
                        player.stageLabel = "Vote for Haiku: Complete";
                        player.stageColor = "Black";
                    }
                } else if (this.stage === "Results" || this.stage === "Winner") {
                    if (this.nextGame === null) {
                        if (this.topicPickerID === player.id) {
                            player.stageLabel = "Pick Topic: Incomplete";
                            player.stageColor = "DarkOrange";
                        } else {
                            player.stageLabel = "Pick Topic: Not this round";
                            player.stageColor = "Black";
                        }
                    } else {
                        for (j = 0; j < this.nextGame.players.length; j += 1) {
                            if (this.nextGame.players[j].id === player.id) {
                                nextPlayer = this.nextGame.players[j];
                                player.stageLabel = nextPlayer.stageLabel;
                                player.stageColor = nextPlayer.stageColor;
                                break;
                            }
                        }
                    }
                }
            }
        };

        this.setDeadlineAge = function () {
            var currentTime,
                delta,
                hours,
                minutes;

            if (this.stage === "Abandoned") {
                this.deadlineAge = "";
                this.deadlineColor = "Black";
                return;
            }
            if (this.nextGame !== null && this.nextGame.stage === "Abandoned") {
                this.deadlineAge = "";
                this.deadlineColor = "Black";
                return;
            }

            currentTime = secondsSinceEpoch();
            delta = this.deadline - currentTime;
            if (this.nextGame !== null) {
                delta = this.nextGame.deadline - currentTime;
            }

            if (delta > 3600) {
                hours = Math.floor(delta / 3600);
                this.deadlineAge = "Deadline: " + hours + " hour" + (hours > 1 ? "s" : "");
                this.deadlineColor = "Black";
            } else if (delta > 60) {
                minutes = Math.floor(delta / 60);
                this.deadlineAge = "Deadline: " + minutes + " minute" + (minutes > 1 ? "s" : "");
                this.deadlineColor = "DarkOrange";
            } else {
                this.deadlineAge = "Deadline: Imminent";
                this.deadlineColor = "Red";
            }
            if (!this.me.actionItem) {
                this.deadlineColor = "Black";
            }
        };

    };

}]);

mod.service('TopicAssistant', ['$http', '$q', '$log', function ($http, $q, $log) {

    "use strict";

    var topics,
        index;

    topics = [];
    index = 1;

    // fischer-yates shuffle in Javascript
    function shuffle(array) {
        var m,
            t,
            i;

        m = array.length;

        // While there remain elements to shuffle…
        while (m) {
            // Pick a remaining element…
            i = Math.floor(Math.random() * m--);

            // And swap it with the current element.
            t = array[m];
            array[m] = array[i];
            array[i] = t;
        }
        return array;
    }

    this.getTopic = function () {
        var deferred,
            topic;

        deferred = $q.defer();

        if (topics.length === 0) {
            $http.get('data/topics.csv')
                .success(function (text) {
                    $log.debug("Parsing topics");
                    topics = text.split("\n");
                    topics = shuffle(topics);
                    deferred.resolve(topics[0]);
                });
        } else {
            topic = topics[index];
            index += 1;
            deferred.resolve(topic);
        }
        return deferred.promise;
    };



}]);

mod.service('SlamPurchase', ['config', '$localstorage', '$http', '$q', '$log', function (config, $localstorage, $http, $q, $log) {
    "use strict";

    $log.debug("Begin SlamPurchase");

    this.apply = function (receipt, signature, unlock) {
        $log.debug("Begin apply");
        var deferred,
            payload;

        deferred = $q.defer();

        payload = {"access_token": $localstorage.get('accessToken', null),
                       "receipt": receipt,
                       "signature": signature,
                       "unlock": unlock};

        $http.put(config.applyURL, payload)
            .then(function (response) {
                $log.debug("Successful callback for apply: ", response);
                switch (response.data.status) {
                case 200:
                    $log.debug("Account was already unlocked");
                    $localstorage.set('unlocked', true);
                    break;
                case 201:
                    $log.debug("Successfully unlocked account");
                    $localstorage.set('unlocked', true);
                    break;
                case 211:
                    $log.debug("Receipt is valid but already applied to another account");
                    deferred.reject(response);
                    break;
                case 212:
                    $log.debug("Receipt is valid, unapplied");
                    break;
                default:
                    break;
                }
                deferred.resolve(response);
            }, function (error) {
                $log.debug("Error callback from apply: ", error);
                deferred.reject(error);
            });
        return deferred.promise;
    };

}]);
