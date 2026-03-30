# passport-http-header-strategy
[![Build Status](https://travis-ci.org/FengYuHe/passport-http-header-strategy.svg?branch=master)](https://travis-ci.org/FengYuHe/passport-http-header-strategy)

HTTP define header authentication strategy for [Passport](https://github.com/jaredhanson/passport)

## Install

	$ npm install passport-http-header-strategy

## Usage
* `header` set header(default `authorization`)
* `param` set use `req.body` or `req.query` `token` name to request(default `access_token`)
*  `passReqToCallback` if eturn

#### Configure Strategy
```js
passport.use(new headerStrategy({header: 'X-APP-TOKEN', param: 'app_token', passReqToCallback: true},
  function(req, token, done) {
    User.findOne({ token: token }, function (err, user) {
      if (err) { return done(err); }
      if (!user) { return done(null, false); }
      return done(null, user, { scope: 'all' });
    });
  }
));
```

#### Authenticate Requests

Use `passport.authenticate()`, specifying the `'bearer'` strategy, to
authenticate requests.  Requests containing bearer tokens do not require session
support, so the `session` option can be set to `false`.

For example, as route middleware in an [Express](http://expressjs.com/)
application:

    app.get('/profile', 
      passport.authenticate('header', { session: false }),
      function(req, res) {
        res.json(req.user);
      });

## Examples
[examples](https://github.com/FengYuHe/passport-http-header-strategy/tree/master/examples) - example

## Tests
	
	$ npm install
	$ mocha

## Reference
Refer[Jared Hanson](https://github.com/jaredhanson) [passport-http-bearer](https://github.com/jaredhanson/passport-http-bearer) module

## License
[The MIT License](http://opensource.org/licenses/MIT)
