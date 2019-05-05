'use strict';

// PROVIDE ACCESS TO ENVIRONMENT VARIABLES IN .env
require('dotenv').config();

// LOAD APPLICATION DEPENDENCIES
const express = require('express');
const cors = require('cors');
const superagent = require('superagent');
const pg = require('pg');

// APPLICATION SETUP
const app = express();
app.use(cors());
const PORT = process.env.PORT;

//CONNECT TO DATABASE
const client = new pg.Client(process.env.DATABASE_URL);
client.connect();
client.on('error', err => console.log(err));

// API ROUTES
app.get('/location', searchToLatLong);
app.get('/weather', getWeather);
app.get('/events', getEvents);
app.get('/movies', getMovies);
app.get('/yelp', getYelp);

// TURN THE SERVER ON
app.listen(PORT, () => console.log(`City Explorer Backend is up on ${PORT}`));

// ERROR HANDLER
function handleError(err, res) {
  console.error(err);
  if (res) res.status(500).send('Sorry, something went wrong');
}

// HELPER FUNCTIONS

// DRY up our code
// 1. Look for similar or duplicate code
//    a. SQL SELECT to check for data in the DB
//    b. SQL INSERT to data into the DB

function getDataFromDB(sqlInfo) {
  // Create a SQL Statement
  let condition = '';
  let values = [];

  if (sqlInfo.searchQuery) {
    condition = 'search_query';
    values = [sqlInfo.searchQuery];
  } else {
    condition = 'location_id';
    values = [sqlInfo.id];
  }

  let sql = `SELECT * FROM ${sqlInfo.endpoint} WHERE ${condition}=$1;`;

  // Get the Data and Return
  try { return client.query(sql, values); }
  catch (error) { handleError(error); }
}

function saveDataToDB(sqlInfo) {
  // Create the parameter placeholders
  let params = [];

  for (let i = 1; i <= sqlInfo.values.length; i++) {
    params.push(`$${i}`);
  }

  let sqlParams = params.join();

  let sql = '';
  if (sqlInfo.searchQuery) {
    // location
    sql = `INSERT INTO ${sqlInfo.endpoint} (${sqlInfo.columns}) VALUES (${sqlParams}) RETURNING ID;`;
  } else {
    // all other endpoints
    sql = `INSERT INTO ${sqlInfo.endpoint} (${sqlInfo.columns}) VALUES (${sqlParams});`;
  }

  // save the data
  try { return client.query(sql, sqlInfo.values); }
  catch (err) { handleError(err); }
}

// CACHE INVALIDATION:

// 1.	Get data from the DB
// 2.	Check to see if the data is expired
// a.	Expired => get new data from API, Save to DB, return
// b.	Good => return existing data

// Establish the length of time to keep data for each resource
// NOTE: the names are singular so they can be dynamically used
// The weather timeout MUST be 15 seconds for this lab. You can change
// The others as you see fit... or not.

// Check to see if the data is still valid
function checkTimeouts(sqlInfo, sqlData) {

  const timeouts = {
    weather: 15 * 1000, // 15-seconds
    yelp: 24 * 1000 * 60 * 60, // 24-Hours
    movie: 30 * 1000 * 60 * 60 * 24, // 30-Days
    event: 6 * 1000 * 60 * 60, // 6-Hours
    trail: 7 * 1000 * 60 * 60 * 24 // 7-Days
  };

  // if there is data, find out how old it is.
  if (sqlData.rowCount > 0) {
    let ageOfResults = (Date.now() - sqlData.rows[0].created_at);

    // For debugging only
    console.log(sqlInfo.endpoint, ' AGE:', ageOfResults);
    console.log(sqlInfo.endpoint, ' Timeout:', timeouts[sqlInfo.endpoint]);

    // Compare the age of the results with the timeout value
    // Delete the data if it is old
    if (ageOfResults > timeouts[sqlInfo.endpoint]) {
      let sql = `DELETE FROM ${sqlInfo.endpoint} WHERE location_id=$1;`;
      let values = [sqlInfo.id];
      client.query(sql, values)
        .then(() => { return null; })
        .catch(error => handleError(error));
    } else { return sqlData; }
  }
}

function searchToLatLong(request, response) {
  let sqlInfo = {
    searchQuery: request.query.data,
    endpoint: 'locations'
  };

  getDataFromDB(sqlInfo)
    .then(result => {
      if (result.rowCount > 0) {
        response.send(result.rows[0]);
      } else {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${request.query.data}&key=${process.env.GEOCODE_API_KEY}`;

        superagent.get(url)
          .then(result => {
            if (!result.body.results.length) { throw 'NO DATA'; }
            else {
              let location = new Location(sqlInfo.searchQuery, result.body.results[0]);

              sqlInfo.columns = Object.keys(location).join();
              sqlInfo.values = Object.values(location);

              saveDataToDB(sqlInfo)
                .then(data => {
                  location.id = data.rows[0].id;
                  response.send(location);
                });
            }
          })
          .catch(error => handleError(error, response));
      }
    });
}

function getWeather(request, response) {

  let sqlInfo = {
    id: request.query.data.id,
    endpoint: 'weathers'
  };

  getDataFromDB(sqlInfo)
    .then(data => checkTimeouts(sqlInfo, data))
    .then(result => {
      if (result) { response.send(result.rows); }
      else {
        const url = `https://api.darksky.net/forecast/${process.env.WEATHER_API_KEY}/${request.query.data.latitude},${request.query.data.longitude}`;

        return superagent.get(url)
          .then(weatherResults => {
            console.log('Weather from API');
            if (!weatherResults.body.daily.data.length) { throw 'NO DATA'; }
            else {
              const weatherSummaries = weatherResults.body.daily.data.map(day => {
                let summary = new Weather(day);
                summary.location_id = sqlInfo.id;

                sqlInfo.columns = Object.keys(summary).join();
                sqlInfo.values = Object.values(summary);

                saveDataToDB(sqlInfo);
                return summary;
              });
              response.send(weatherSummaries);
            }
          })
          .catch(error => handleError(error, response));
      }
    });
}

function getEvents(request, response) {
  let sqlInfo = {
    id: request.query.data.id,
    endpoint: 'events'
  };

  getDataFromDB(sqlInfo)
    .then(data => checkTimeouts(sqlInfo, data))
    .then(result => {
      if (result) { response.send(result.rows); }
      else {
         const url =`https://www.eventbriteapi.com/v3/events/search/?token=${process.env.EVENTBRITE_API_KEY}&location.latitude=${request.query.data.latitude}&location.longitude=${request.query.data.longitude}`;


        return superagent.get(url)
          .then(eventResults => {
            console.log('Event from API');
            if (!eventResults.body.events.length) { throw 'NO DATA'; }
            else {
              const eventSummaries = eventResults.body.events.map(event => {
                let summary = new Event(event);
                summary.location_id = sqlInfo.id;

                sqlInfo.columns = Object.keys(summary).join();
                sqlInfo.values = Object.values(summary);

                saveDataToDB(sqlInfo);
                return summary;
              });
              response.send(eventSummaries);
            }
          })
          .catch(error => handleError(error, response));
      }
    });
}

function getMovies(request, response) {
  let sqlInfo = {
    id: request.query.data.id,
    endpoint: 'movies'
  };

  getDataFromDB(sqlInfo)
    .then(data => checkTimeouts(sqlInfo, data))
    .then(result => {
      if (result) { response.send(result.row); }
      else {
        console.log('=================');
        console.log(request.query);
        const url = `https://api.themoviedb.org/3/search/movie?api_key=${process.env.MOVIE_API_KEY}&language=en-US&query=${request.query.data.search_query}&page=1&include_adult=false`;

        return superagent.get(url)
        .then(movieResults => {
        console.log('Movie in API');
        if (!movieResults.body.results.length) { throw 'NO DATA'; }
          else {
            const movieSummaries = movieResults.body.results.map(movie => {
              let summary = new Movie(movie);
              summary.location_id = sqlInfo.id;

              sqlInfo.columns = Object.keys(summary).join();
              sqlInfo.values = Object.values(summary);

              saveDataToDB(sqlInfo);
              return summary;
            });
            response.send(movieSummaries);
          }
        })
        .catch(error => handleError(error, response));
      }
    });
}

function getYelp (request, response) {
  let sqlInfo = {
    id: request.query.data.id,
    endpoint: 'yelps'
  };
  getDataFromDB(sqlInfo)
    .then(data => checkTimeouts(sqlInfo,data))
    .then(result => {
      if (result) {response.send(result.rows);}
      else {
        const url = `https://api.yelp.com/v3/businesses/search?latitude=${request.query.data.latitude}&longitude=${request.query.data.longitude}`;
       
        return superagent.get(url)
          .set({'Authorization': 'Bearer '+ process.env.YELP_API_KEY})
          .then(yelpResults => {
            if (!yelpResults.body.businesses.length) { throw 'NO DATA'; }
            else {
              const yelpSummaries = yelpResults.body.businesses.map( biz => {
                let summary = new Yelp(biz);
                summary.location_id = sqlInfo.id;
                console.log(summary);

                sqlInfo.columns = Object.keys(summary).join();
                sqlInfo.values = Object.values(summary);

                saveDataToDB(sqlInfo);
                return summary;
              });
              response.send(yelpSummaries);
            }
          })
          .catch(err => handleError(err, response));
      }
    });
}

//DATA MODELS
function Location(query, location) {
  this.search_query = query;
  this.formatted_query = location.formatted_address;
  this.latitude = location.geometry.location.lat;
  this.longitude = location.geometry.location.lng;
}

function Weather(day) {
  this.forecast = day.summary;
  this.time = new Date(day.time * 1000).toString().slice(0, 15);
  this.created_at = Date.now();
}

function Event(event) {
  this.link = event.url;
  this.name = event.name.text;
  this.event_date = new Date(event.start.local).toString().slice(0, 15);
  this.summary = event.summary;
}

function Movie(movie) {
  this.title = movie.original_title;
  this.overview = movie.overview.slice(0, 750);
  this.average_votes = movie.votes_average;
  this.total_votes = movie.vote_count;
  this.image_url = `https://image.tmdb.org/t/p/original${movie.poster_path}` ;
  this.popularity = movie.popularity;
  this.released_on = movie.release_date;
  this.created_at = Date.now();
}

function Yelp (yelp) {
  this.name = yelp.name;
  this.image_url = yelp.image_url;
  this.price = yelp.price;
  this.rating = yelp.rating;
  this.url = yelp.url;
  this.created_at = Date.now();
}
